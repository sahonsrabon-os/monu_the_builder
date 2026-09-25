#!/usr/bin/env node
'use strict';

/**
 * cdp-pipe.js — headless Chrome over --remote-debugging-pipe (ZERO HTTP).
 *
 * 🧟 Ethical browsing tool (#7):
 *   Chrome is launched with `--remote-debugging-pipe`. CDP JSON messages
 *   travel over **file descriptor 3 (write) / 4 (read)** with `\0` framing.
 *   → No debug port, no TCP, no WebSocket, no HTTP anywhere in the
 *     control channel. Nothing can snarf the DevTools socket.
 *   The PAGE itself may load http(s)/file URLs — that is Chrome doing
 *     its job; OUR code never opens a socket.
 *
 * Zero-dependency, CommonJS. Used by api.js MCP tool `browse_cdp`.
 *
 * Public API:
 *   browseCdp({ url, action, timeout_ms }) → { ok, url, ... }
 *   CLI test:  node cdp-pipe.js <url> [text|html|title|screenshot]
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const CHROME_BIN = process.env.CHROME_BIN || "/opt/google/chrome/chrome";
const TMP_ROOT = "/tmp/opencode";
const DEFAULT_TIMEOUT = 20000;

class CDPipe {
  constructor() {
    this.proc = null;
    this.msgId = 0;
    this.pending = new Map(); // id → {resolve, reject, timer}
    this.buf = "";
    this.toChild = null;
    this.fromChild = null;
    this.exited = false;
  }

  start() {
    if (this.proc) return;
    if (!fs.existsSync(CHROME_BIN)) {
      throw new Error("chrome binary not found: " + CHROME_BIN);
    }
    const profile = path.join(TMP_ROOT, "cdp-pipe-profile-" + Date.now());
    fs.mkdirSync(profile, { recursive: true });
    // stdio[0]=ignore, [1]=pipe(chrome stdout, unused by pipe mode),
    // [2]=pipe(stderr), [3]=pipe → CDP write channel, [4]=pipe → CDP read.
    this.proc = spawn(
      CHROME_BIN,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars",
        "--user-data-dir=" + profile,
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
    );
    this.toChild = this.proc.stdio[3];
    this.fromChild = this.proc.stdio[4];
    this.fromChild.setEncoding("utf8");
    this.fromChild.on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", (code) => {
      this.exited = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("chrome exited (code " + code + ")"));
      }
      this.pending.clear();
    });
    this.proc.stderr.on("data", () => {}); // keep drained
    // Give chrome a moment to spin up its pipe endpoint
    return new Promise((r) => setTimeout(r, 400));
  }

  _onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\0")) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!raw) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_) {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || "cdp error"));
        else p.resolve(msg.result || {});
      }
      // events are ignored (we only need request/response pairs)
    }
  }

  send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.toChild) {
        return reject(new Error("chrome not running"));
      }
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP timeout: " + method));
      }, DEFAULT_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({
        id,
        method,
        params: params || {},
        ...(sessionId ? { sessionId } : {}),
      });
      this.toChild.write(payload + "\0");
    });
  }

  async browse({ url, action = "text", timeout_ms }) {
    if (!url || typeof url !== "string") throw new Error("url is required");
    if (!/^(https?:|file:)/i.test(url.trim())) {
      throw new Error("url must start with http:// https:// or file://");
    }
    await this.start();
    // Browser-level: open a target + attach flat session
    const { targetId } = await this.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    try {
      await this.send("Page.enable", {}, sessionId);
      await this.send("Runtime.enable", {}, sessionId);
      // Navigate — Chrome fetches the page itself (our code: no socket)
      const nav = await this.send(
        "Page.navigate",
        { url: url.trim() },
        sessionId,
      );
      if (nav.errorText) throw new Error("navigate: " + nav.errorText);
      // Wait for load (poll readyState — no event bookkeeping needed)
      const deadline = Date.now() + (timeout_ms || DEFAULT_TIMEOUT);
      let ready = "loading";
      while (ready === "loading" && Date.now() < deadline) {
        const r = await this.send(
          "Runtime.evaluate",
          {
            expression: "document.readyState",
            returnByValue: true,
          },
          sessionId,
        );
        ready = (r.result && r.result.value) || "loading";
        if (ready === "loading") await new Promise((r2) => setTimeout(r2, 250));
      }
      const finalUrl = await this.eval("location.href", sessionId);
      const title = await this.eval("document.title", sessionId);
      const out = { ok: true, url: finalUrl || url, title: title || "" };

      if (action === "html") {
        out.html = (await this.eval("document.documentElement.outerHTML", sessionId)) || "";
      } else if (action === "title") {
        // title already collected
      } else if (action === "screenshot") {
        const shot = await this.send(
          "Page.captureScreenshot",
          { format: "png" },
          sessionId,
        );
        out.png_base64 = shot.data || "";
      } else {
        // default: readable text
        out.text =
          (await this.eval(
            "document.body ? document.body.innerText : ''",
            sessionId,
          )) || "";
      }
      return out;
    } finally {
      try {
        await this.send("Target.closeTarget", { targetId });
      } catch (_) { /* already gone */ }
    }
  }

  async eval(expression, sessionId) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
    );
    return r.result ? r.result.value : null;
  }

  stop() {
    if (this.proc && !this.exited) {
      try {
        this.toChild && this.toChild.end();
      } catch (_) {}
      this.proc.kill("SIGKILL");
    }
    this.proc = null;
  }
}

// ─── Shared lazy instance (one chrome for the process, reused) ──
let shared = null;
async function browseCdp(opts) {
  if (!shared || shared.exited) shared = new CDPipe();
  return await shared.browse(opts || {});
}
function stopCdp() {
  if (shared) shared.stop();
  shared = null;
}

module.exports = { CDPipe, browseCdp, stopCdp };

// ─── CLI self-test (pipe only, zero HTTP from this script) ──────
if (require.main === module) {
  (async () => {
    const url = process.argv[2] || "about:blank";
    const action = process.argv[3] || "text";
    const c = new CDPipe();
    try {
      const r = await c.browse({ url, action });
      if (action === "screenshot") {
        console.log(JSON.stringify({ ...r, png_base64: "<" + (r.png_base64 || "").length + " bytes>" }));
      } else {
        const copy = { ...r };
        if (copy.html) copy.html = copy.html.slice(0, 400) + "…";
        if (copy.text) copy.text = copy.text.slice(0, 800);
        console.log(JSON.stringify(copy, null, 2));
      }
    } finally {
      c.stop();
    }
  })().catch((e) => {
    console.error("FAIL:", e.message);
    process.exit(1);
  });
}
