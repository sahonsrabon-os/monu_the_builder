"use strict";

/**
 * note-store.js — v3.1.1
 * Zero-dependency note storage for Mission Barisal.
 *
 * Base: v3.1.0 (as supplied). Changes in v3.1.1:
 *   • FIX decryptText(): HMAC was computed over `cipher` but verified over
 *     `cipher + ":"` — every encrypted load failed with "HMAC mismatch".
 *     The colon separator is now stripped before verification/decryption.
 *   • FIX old-format (iv:cipher) support — the old `parts.length < 3` guard
 *     rejected the 2-part format the header claimed to support.
 *   • FAIL CLOSED: encrypted-but-unreadable data aborts init (files left
 *     untouched) instead of silently starting fresh and letting the next
 *     flush rotate the only good ciphertext out of existence.
 *   • Recovery writes re-serialize through the active encryption (v3.1.0
 *     wrote recovered data back as PLAINTEXT even with a key set).
 *   • DATA_DIR now falls back to <module dir>/data so the store works no
 *     matter which cwd `node api.js` is started from (env still wins).
 *   • setNote() now stamps `created` on new notes (cleanNotes age check
 *     no longer relies on the `updated` fallback alone).
 *
 * ─── API ─────────────────────────────────────────────────────
 *   initNoteStore()    — Initialize data dir & load notes
 *   getNote(id)        — Get a note by session/module ID
 *   setNote(id, data)  — Set/update a note
 *   listNotes()        — Get all note IDs
 *   cleanNotes(maxAge) — Remove expired notes
 *   flushSync()        — Force sync flush (drains queue first)
 * ─────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");  // Built-in in Node.js — zero dependency

// Env wins; otherwise resolve against THIS file's directory (never cwd).
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, "data"),
);
const NOTE_FILE = path.join(DATA_DIR, "notes.json");
const LOCK_FILE = path.join(DATA_DIR, ".note-store.lock");
// NOTE: read at call time, not module load time, so env changes take effect
// at runtime (env vars are the single source of truth).
function getNoteTtl() {
  return parseInt(process.env.NOTE_TTL || "86400000", 10);
}
function getMaxNoteSize() {
  return parseInt(process.env.MAX_NOTE_SIZE || "512000", 10);
}
function getEncryptionKey() {
  return process.env.NOTE_ENCRYPTION_KEY || null;
}

let notes = {};
let initialized = false;
let cleanInterval = null;  // Module-level ref to prevent interval stacking

// ─── Write Queue — serializes setNote calls ──────────────────
let writeChain = Promise.resolve();

// ─── Debounce Timer — accumulates writes ─────────────────────
let flushTimer = null;
let flushNeeded = false;

// ─── Encryption / Decryption ─────────────────────────────────

function encryptText(text) {
  const encKey = getEncryptionKey();
  if (!encKey) return text;
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(encKey, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", derivedKey, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  // Format: salt:iv:ciphertext:hmac   (HMAC covers the ciphertext ONLY)
  const hmac = crypto.createHmac("sha256", derivedKey).update(encrypted).digest("hex");
  return salt.toString("hex") + ":" + iv.toString("hex") + ":" + encrypted + ":" + hmac;
}

/**
 * Decrypt notes.json content.
 *   new format: salt:iv:cipher:hmac  (4 colon-separated fields)
 *   old format: iv:cipher            (2 fields, no salt/HMAC)
 * Returns plaintext string, original text when no key/foreign format,
 * or null on authentication/decryption failure.
 */
function decryptText(text) {
  const encKey = getEncryptionKey();
  if (!encKey) return text;
  try {
    const parts = text.split(":");
    if (parts.length < 2) return text;

    let salt = null;
    let ivHex;
    let cipherHex;
    let hmacHex = "";

    if (parts.length >= 4) {
      // new format: salt:iv:cipher:hmac
      salt = Buffer.from(parts.shift(), "hex");   // salt
      ivHex = parts.shift();                      // iv
      hmacHex = parts.pop();                      // hmac (last 64 hex chars)
      cipherHex = parts.join(":");                // ciphertext (no ':' inside)
    } else {
      // old format: iv:cipher
      ivHex = parts.shift();
      cipherHex = parts.join(":");
    }

    const derivedKey = crypto.scryptSync(encKey, salt || Buffer.alloc(16), 32);

    if (hmacHex) {
      // v3.1.0 BUG: verified HMAC over `cipher + ":"` (the join separator),
      // which never matches the HMAC computed over `cipher` at encrypt time.
      const expectedHmac = crypto.createHmac("sha256", derivedKey).update(cipherHex).digest("hex");
      if (expectedHmac !== hmacHex) {
        throw new Error("HMAC mismatch — data may be tampered");
      }
    }

    const iv = Buffer.from(ivHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", derivedKey, iv);
    let decrypted = decipher.update(cipherHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (err) {
    console.error("[NOTE-STORE] Decryption failed:", err.message);
    if (text.includes(":") && text.length > 64) {
      console.warn("[NOTE-STORE] WARNING: Data appears encrypted but decryption failed. Check NOTE_ENCRYPTION_KEY.");
    }
    return null;
  }
}

// ─── Multi-Instance Locking ──────────────────────────────────

function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, started: Date.now() }));
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === "EEXIST") {
      try {
        const content = fs.readFileSync(LOCK_FILE, "utf8");
        const lockData = JSON.parse(content);
        // A lock is stale if the process that owns it is no longer alive —
        // this prevents a crash-within-30s from blocking a legitimate restart
        // and risking corruption (the previous 30s-only check ignored PID liveness).
        if (lockData && typeof lockData.pid === "number") {
          let alive = false;
          try {
            process.kill(lockData.pid, 0);
            alive = true;
          } catch (killErr) {
            alive = killErr.code !== "ESRCH"; // ESRCH = dead; EPERM/other = be safe
          }
          if (!alive) {
            fs.unlinkSync(LOCK_FILE);
            return acquireLock();
          }
        }
        // Fallback: stale by age.
        if (Date.now() - (lockData.started || 0) > 30000) {
          fs.unlinkSync(LOCK_FILE);
          return acquireLock();
        }
      } catch (_) { }
      return false;
    }
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (_) { }
}

// ─── Helpers ─────────────────────────────────────────────────

function now() {
  return Date.now();
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteSync(filePath, content) {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function rotateBackup(filePath) {
  if (!fs.existsSync(filePath)) return;
  const bak1 = filePath + ".bak1";
  const bak2 = filePath + ".bak2";
  const bak3 = filePath + ".bak3";
  if (fs.existsSync(bak2)) fs.renameSync(bak2, bak3);
  if (fs.existsSync(bak1)) fs.renameSync(bak1, bak2);
  fs.renameSync(filePath, bak1);
}

function validateNoteData(id, data) {
  if (!id || typeof id !== "string" || id.trim() === "") {
    return { valid: false, reason: "id must be a non-empty string" };
  }
  if (id.startsWith("_")) {
    return { valid: false, reason: "id starting with '_' is reserved (e.g. _meta)" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, reason: "data must be a plain object" };
  }
  if (Object.keys(data).length === 0) {
    return { valid: false, reason: "data cannot be empty" };
  }
  const sizeEstimate = JSON.stringify(data).length;
  if (sizeEstimate > getMaxNoteSize()) {
    return { valid: false, reason: "data exceeds " + getMaxNoteSize() + " byte limit (got " + sizeEstimate + ")" };
  }
  return { valid: true };
}

/**
 * True when the file is (or was) ciphertext — used to FAIL CLOSED instead of
 * silently starting fresh and rotating the last good ciphertext out of reach.
 */
function looksEncrypted(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (raw.startsWith("{")) return false;
    // new: salt:iv:cipher:hmac   old: iv:cipher
    return /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+:[0-9a-f]{64}$/i.test(raw) ||
           /^[0-9a-f]{32}:[0-9a-f]+$/i.test(raw);
  } catch (_) {
    return false;
  }
}

function serializeNotes() {
  let content = JSON.stringify(notes, null, 2);
  if (getEncryptionKey()) content = encryptText(content);
  return content;
}

/**
 * Read file content with decryption support.
 * Handles: plain JSON, old format (iv:ciphertext), new format (salt:iv:ciphertext:hmac)
 * Returns parsed object or throws on failure.
 */
function readNotesFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  // Try plain JSON first (backward compat with v2/v3 without encryption)
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed;
  } catch (_) { /* not plain JSON — try decryption */ }
  // Try decryption
  const decrypted = decryptText(raw);
  if (decrypted === null) {
    throw new Error("Decryption failed — check NOTE_ENCRYPTION_KEY or data may be corrupted");
  }
  return JSON.parse(decrypted);
}

/**
 * Serialized write to disk via write queue.
 * Encrypts content if encryption key is set.
 * Also encrypts backup files to prevent plaintext leak.
 */
function performWrite() {
  try {
    ensureDir(DATA_DIR);
    let content = JSON.stringify(notes, null, 2);
    const encKey = getEncryptionKey();
    if (encKey) {
      content = encryptText(content);
    }
    rotateBackup(NOTE_FILE);
    atomicWriteSync(NOTE_FILE, content);
    // If encryption is on, encrypt backup files too (prevents plaintext leak)
    if (encKey) {
      const bak1 = NOTE_FILE + ".bak1";
      if (fs.existsSync(bak1)) {
        try {
          const bakRaw = fs.readFileSync(bak1, "utf8");
          if (bakRaw.trim().startsWith("{")) {
            atomicWriteSync(bak1, encryptText(bakRaw));
          }
        } catch (_) { }
      }
    }
  } catch (err) {
    try {
      let content = JSON.stringify(notes, null, 2);
      if (getEncryptionKey()) content = encryptText(content);
      fs.writeFileSync(NOTE_FILE, content, "utf8");
    } catch (fatal) {
      console.error("[NOTE-STORE] Flush error:", fatal.message);
    }
  }
}

// ─── Flush Functions ─────────────────────────────────────────

function scheduleFlush() {
  flushNeeded = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!flushNeeded) return;
    flushNeeded = false;
    writeChain = writeChain.then(() => performWrite());
  }, 150);
}

function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // A forced sync MUST always persist, regardless of the debounce flag.
  // (initNoteStore calls this directly on fresh-create with flushNeeded=false,
  //  so the old `if (flushNeeded)` guard silently dropped the first write.)
  flushNeeded = false;
  performWrite();
  return true;
}

// ─── Public API ──────────────────────────────────────────────

function initNoteStore() {
  ensureDir(DATA_DIR);

  if (!acquireLock()) {
    console.warn("[NOTE-STORE] WARNING: Another instance is using " + DATA_DIR + " (lock file exists). Data corruption possible if both write simultaneously.");
  }

  if (fs.existsSync(NOTE_FILE)) {
    try {
      notes = readNotesFile(NOTE_FILE);
      console.log(
        "[NOTE-STORE] Loaded: " +
        Object.keys(notes).length +
        " notes — " +
        NOTE_FILE +
        (getEncryptionKey() ? " [ENCRYPTED]" : " [PLAIN]"),
      );
    } catch (err) {
      console.log("[NOTE-STORE] Main file corrupt, trying .bak1: " + err.message);
      const bak1 = NOTE_FILE + ".bak1";
      let recovered = false;
      if (fs.existsSync(bak1)) {
        try {
          notes = readNotesFile(bak1);
          recovered = true;
          console.log("[NOTE-STORE] Recovered from .bak1: " + Object.keys(notes).length + " notes");
          atomicWriteSync(NOTE_FILE, serializeNotes());
        } catch (bakErr) {
          console.log("[NOTE-STORE] .bak1 also unreadable:", bakErr.message);
        }
      }
      if (!recovered) {
        // v3.1.1: FAIL CLOSED for encrypted-but-unreadable data. v3.1.0
        // started fresh here, so the next flush rotated the only good
        // ciphertext (.bak1 -> .bak2 -> .bak3 -> gone): silent data loss.
        if (looksEncrypted(NOTE_FILE) || looksEncrypted(bak1)) {
          throw new Error(
            "[NOTE-STORE] Abort: notes are encrypted but unreadable with the " +
            "current NOTE_ENCRYPTION_KEY — files left untouched for recovery. " +
            "(" + err.message + ")",
          );
        }
        notes = {};
        console.log("[NOTE-STORE] No usable backup, starting fresh:", err.message);
      }
    }
  } else {
    // notes.json missing — check if .bak1 exists (crash recovery during write)
    const bak1 = NOTE_FILE + ".bak1";
    if (fs.existsSync(bak1)) {
      try {
        notes = readNotesFile(bak1);
        console.log("[NOTE-STORE] Recovered from .bak1 (" + Object.keys(notes).length + " notes) — notes.json was missing (crash during write)");
        atomicWriteSync(NOTE_FILE, serializeNotes());
      } catch (bakErr) {
        if (looksEncrypted(bak1)) {
          throw new Error(
            "[NOTE-STORE] Abort: backup is encrypted but unreadable with the " +
            "current NOTE_ENCRYPTION_KEY — files left untouched. (" + bakErr.message + ")",
          );
        }
        console.log("[NOTE-STORE] .bak1 also corrupt, starting fresh:", bakErr.message);
        notes = {};
      }
    } else {
      notes = {
        _meta: {
          created: now(),
          version: "3.1.1",
          domain: process.env.DOMAIN || "localhost",
        },
      };
      flushSync();
      console.log("[NOTE-STORE] Created fresh — " + NOTE_FILE);
    }
  }

  // Clear previous interval on re-init to prevent stacking
  if (cleanInterval) {
    clearInterval(cleanInterval);
    console.log("[NOTE-STORE] Cleared previous auto-clean interval (re-init detected)");
  }
  const CLEAN_INTERVAL = parseInt(process.env.NOTE_CLEAN_INTERVAL || "3600000", 10);
  cleanInterval = setInterval(() => {
    const removed = cleanNotes(getNoteTtl());
    if (removed > 0) {
      console.log("[NOTE-STORE] Auto-cleaned " + removed + " expired notes");
    }
  }, CLEAN_INTERVAL);
  // Do not keep the process alive just for the auto-clean timer.
  if (typeof cleanInterval.unref === "function") cleanInterval.unref();

  initialized = true;
  return { ok: true, noteCount: Object.keys(notes).length };
}

function getNote(id) {
  if (!initialized) return null;
  if (!id || typeof id !== "string") return null;
  return notes[id] || null;
}

function setNote(id, data) {
  if (!initialized) throw new Error("note-store not initialized");
  const validation = validateNoteData(id, data);
  if (!validation.valid) {
    throw new Error("[NOTE-STORE] setNote rejected: " + validation.reason);
  }
  const existing = notes[id];
  notes[id] = {
    ...(existing || {}),
    ...data,
    created: (existing && existing.created) || now(),
    updated: now(),
  };
  scheduleFlush();
  return notes[id];
}

function listNotes() {
  if (!initialized) return [];
  return Object.keys(notes).filter((k) => !k.startsWith("_"));
}

function cleanNotes(maxAgeMs) {
  if (!initialized) return 0;
  const cutoff = now() - maxAgeMs;
  let removed = 0;
  for (const [id, note] of Object.entries(notes)) {
    if (id.startsWith("_")) continue;
    if ((note.created || note.updated || 0) < cutoff) {
      delete notes[id];
      removed++;
    }
  }
  if (removed > 0) flushSync();
  return removed;
}

// Clean up lock file on exit
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });

module.exports = {
  initNoteStore,
  getNote,
  setNote,
  listNotes,
  cleanNotes,
  flushSync,
};
