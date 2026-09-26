#!/usr/bin/env node
/**
 * local-llm-bridge.js — Local LLM Socket Bridge for Mission Barisal
 * ==================================================================
 * PURPOSE
 *   Run llama.cpp (or Ollama) behind ONE clean OpenAI-compatible
 *   endpoint that ANY client can use with NO special headers or auth,
 *   over a local Unix socket or loopback TCP. All local-model quirks
 *   (think tags, tool-call formats, JSON preambles, empty replies)
 *   are absorbed HERE so the main gateway (api.js) stays clean.
 *
 * TRANSPORTS SERVED (dual bind, same handler):
 *   - Unix domain socket : /tmp/local-llm.sock   (pure IPC, no network)
 *   - Loopback TCP       : 127.0.0.1:11435        (any HTTP client)
 *
 * GATEWAY WIRING (in /home/sahon/vs/.env):
 *   CUSTOM_PROVIDER_5_NAME=local_llm
 *   CUSTOM_PROVIDER_5_URL=http://127.0.0.1:11435/v1
 *   CUSTOM_PROVIDER_5_SOCKET=/tmp/local-llm.sock
 *   CUSTOM_PROVIDER_5_MODELS=llama-local
 * (api.js prefers the Unix socket when the file exists -> UDS_OUTBOUND)
 *
 * QUIRK LAYER (every local oddity lives in this one file):
 *   Q1 auth-optional      : Authorization accepted, never required
 *   Q2 model aliasing     : any caller model name -> configured GGUF
 *   Q3 think-strip        : reasoning markers removed from content
 *                           (moved to reasoning_content); works on
 *                           non-stream AND stream (holdback scanner)
 *   Q4 tool-call parsing  : text formats (function_calls block, fenced
 *                           JSON {name,arguments}, function-prefix JSON)
 *                           converted to real OpenAI tool_calls
 *   Q5 empty-retry        : empty reply while tools were sent ->
 *                           auto-retry once WITHOUT tools
 *   Q6 tool-reject retry  : backend rejects tools (template/grammar)
 *                           -> retry once with JSON-tool hint system
 *   Q7 json extract       : response_format json_object -> first
 *                           balanced JSON value extracted from prose
 *   Q8 usage fill         : missing usage -> estimated + flagged
 *   Q9 stream normalize   : id/created/model stamped on every chunk,
 *                           guaranteed [DONE], ": hb" heartbeat every
 *                           15s (kills client idle-timeouts)
 *  Q10 header-tolerant    : body parsed regardless of Content-Type,
 *                           permissive CORS, no auth on any route
 *
 * CONFIG (env, all optional; defaults fit this machine):
 *   BRIDGE_BACKEND        auto | llama | ollama   (default auto)
 *   LLAMA_SERVER_BIN      path to llama-server    (auto-detected)
 *   BRIDGE_GGUF           path to .gguf           (auto-detected)
 *   BRIDGE_MODEL          wire model name         (default llama-local)
 *   BRIDGE_PORT           loopback TCP port       (default 11435)
 *   BRIDGE_SOCKET         unix socket path        (default /tmp/local-llm.sock)
 *   BRIDGE_INTERNAL_PORT  llama-server loopback   (default 18777)
 *   BRIDGE_UPSTREAM_MODEL model name for backend  (default BRIDGE_MODEL)
 *   BRIDGE_OLLAMA_URL     ollama base             (default http://127.0.0.1:11434)
 *   BRIDGE_CTX            llama-server ctx size   (default 16384)
 *   BRIDGE_THREADS        llama-server threads    (default cpu count)
 *   BRIDGE_TIMEOUT_MS     upstream timeout        (default 280000)
 *
 * START:  node local-llm-bridge.js
 * STOP:   Ctrl-C (kills llama-server child, unlinks socket)
 *
 * Zero external dependencies. Node >= 18.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

// ── Config ────────────────────────────────────────────────────
const HOME = os.homedir();
const MODEL_DIR = path.join(HOME, ".local", "share", "models");
const LLAMA_DIR = path.join(HOME, ".local", "share", "llama.cpp");

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function findLlamaServer() {
  if (process.env.LLAMA_SERVER_BIN && fs.existsSync(process.env.LLAMA_SERVER_BIN)) {
    return process.env.LLAMA_SERVER_BIN;
  }
  let found = null;
  try {
    const stack = [LLAMA_DIR];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === "llama-server") {
          found = full;
          break;
        }
      }
      if (found) break;
    }
  } catch (_) {}
  if (found) return found;
  try {
    return (
      execSync("command -v llama-server", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || null
    );
  } catch (_) {
    return null;
  }
}

/**
 * GGUF discovery (PORTABLE — no folder is treated as final):
 *   1. BRIDGE_GGUF env        — exact path wins if it exists
 *   2. BRIDGE_GGUF_HINT env   — substring match (e.g. "Meta-Llama-3.1-8B")
 *      scanned across EVERY known model root
 *   3. newest *.gguf found anywhere in the roots
 * Roots scanned (all relocatable, all optional):
 *   ~/.local/share/models, ~/.cache/huggingface/hub (recursive)
 * Moving the whole folder elsewhere = just re-set the env (or nothing,
 * if the scan roots still resolve). ZERO hardcoded final paths.
 */
function scanGgufRoots() {
  const roots = [MODEL_DIR, path.join(HOME, ".cache", "huggingface", "hub")];
  const found = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".gguf")) {
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch (_) {}
          found.push({ path: full, mtime });
        }
      }
    }
  }
  return found;
}

function detectGguf() {
  if (process.env.BRIDGE_GGUF && fs.existsSync(process.env.BRIDGE_GGUF)) {
    return process.env.BRIDGE_GGUF;
  }
  const cands = scanGgufRoots();
  if (!cands.length) return null;
  const hint = process.env.BRIDGE_GGUF_HINT;
  if (hint) {
    const hit = cands.filter((c) => c.path.includes(hint));
    if (hit.length) {
      hit.sort((a, b) => b.mtime - a.mtime);
      return hit[0].path;
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0].path;
}

const CFG = {
  backend: (process.env.BRIDGE_BACKEND || "auto").toLowerCase(),
  llamaBin: findLlamaServer(),
  gguf: detectGguf(),
  model: process.env.BRIDGE_MODEL || "llama-local",
  port: parseInt(process.env.BRIDGE_PORT || "11435", 10),
  socket: process.env.BRIDGE_SOCKET || "/tmp/local-llm.sock",
  internalPort: parseInt(process.env.BRIDGE_INTERNAL_PORT || "18777", 10),
  upstreamModel:
    process.env.BRIDGE_UPSTREAM_MODEL || process.env.BRIDGE_MODEL || "llama-local",
  ollamaUrl: process.env.BRIDGE_OLLAMA_URL || "http://127.0.0.1:11434",
  ctx: parseInt(process.env.BRIDGE_CTX || "16384", 10),
  threads: parseInt(process.env.BRIDGE_THREADS || String(os.cpus().length), 10),
  timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS || "280000", 10),
};

if (CFG.backend === "auto") {
  CFG.backend = CFG.llamaBin && CFG.gguf ? "llama" : "ollama";
}

const UPSTREAM_BASE =
  CFG.backend === "ollama"
    ? CFG.ollamaUrl.replace(/\/$/, "")
    : "http://127.0.0.1:" + CFG.internalPort;

// ── Logging ───────────────────────────────────────────────────
function log(level, msg, extra) {
  const t = new Date().toISOString().slice(11, 19);
  const ex = extra ? " " + JSON.stringify(extra) : "";
  console.log(t + " [bridge:" + level + "] " + msg + ex);
}

// ── Think-tag handling (Q3) ───────────────────────────────────
// Closing markers are built with string concatenation on purpose:
// keeps this file free of raw closing-tag literals in source strings.
const THINK_OPEN = ["<|think|>", "<" + "think>", "<" + "reasoning>"];
const THINK_CLOSE = [
  "<" + "/|think|>",
  "<" + "/think>",
  "<" + "/reasoning>",
  "<" + "|/think|>",
];
const ALL_MARKERS = THINK_OPEN.concat(THINK_CLOSE);

/** Non-stream: drop complete reasoning segments, keep the rest. */
function stripThink(text) {
  if (!text) return { content: text || "", stripped: "" };
  let out = text;
  let stripped = "";
  for (const open of THINK_OPEN) {
    for (;;) {
      const idx = out.indexOf(open);
      if (idx === -1) break;
      // find the nearest close marker after this open
      let end = -1;
      for (const close of THINK_CLOSE) {
        const c = out.indexOf(close, idx + open.length);
        if (c !== -1 && (end === -1 || c < end)) end = c + close.length;
      }
      if (end === -1) end = idx + open.length; // unclosed: drop opener only
      stripped += out.slice(idx, end) + "\n";
      out = out.slice(0, idx) + out.slice(end);
    }
  }
  return { content: out.replace(/^[ \t\r\n]+/, ""), stripped: stripped.trim() };
}

/**
 * Stream: incremental holdback scanner. A delta is only released once we
 * KNOW it is outside a reasoning segment. A partial marker at the tail is
 * always held (markers can split across SSE chunks).
 */
function makeThinkFilter() {
  let inThink = false;
  let pending = "";

  function partialMarkerHold(s) {
    let hold = 0;
    for (const m of ALL_MARKERS) {
      for (let k = m.length - 1; k > hold && k <= s.length; k--) {
        if (s.length >= k && s.slice(s.length - k) === m.slice(0, k)) {
          hold = k;
          break;
        }
      }
    }
    return hold;
  }

  return {
    push(delta) {
      pending += delta;
      let emit = "";
      for (;;) {
        if (inThink) {
          let best = -1;
          let bestLen = 0;
          for (const c of THINK_CLOSE) {
            const i = pending.indexOf(c);
            if (i !== -1 && (best === -1 || i < best)) {
              best = i;
              bestLen = c.length;
            }
          }
          if (best === -1) return emit; // still reasoning -> hold everything
          pending = pending.slice(best + bestLen);
          inThink = false;
          continue;
        }
        let openIdx = -1;
        let openLen = 0;
        for (const o of THINK_OPEN) {
          const i = pending.indexOf(o);
          if (i !== -1 && (openIdx === -1 || i < openIdx)) {
            openIdx = i;
            openLen = o.length;
          }
        }
        if (openIdx === -1) {
          const hold = partialMarkerHold(pending);
          const safeLen = pending.length - hold;
          emit += pending.slice(0, safeLen);
          pending = pending.slice(safeLen);
          return emit;
        }
        emit += pending.slice(0, openIdx);
        pending = pending.slice(openIdx + openLen);
        inThink = true;
      }
    },
    flush() {
      const out = pending;
      pending = "";
      return out;
    },
  };
}

// ── Tool-call text extraction (Q4) ────────────────────────────
function randId() {
  return "call_" + crypto.randomBytes(8).toString("hex");
}

function safeJsonString(v) {
  if (v == null) return "{}";
  if (typeof v === "string") {
    try {
      JSON.parse(v);
      return v;
    } catch (_) {
      return JSON.stringify({ _: v });
    }
  }
  return JSON.stringify(v);
}

function parseToolCalls(text) {
  if (!text || typeof text !== "string") return null;
  const calls = [];

  // Pattern 1: function_calls block with invoke/parameter children
  const block = text.match(/<function_calls>[\s\S]*?<\/function_calls>/);
  if (block) {
    const invokes = block[0].matchAll(
      /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g,
    );
    for (const inv of invokes) {
      const args = {};
      const params = inv[2].matchAll(
        /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g,
      );
      for (const p of params) {
        const key = p[1];
        let val = p[2].trim();
        try {
          val = JSON.parse(val);
        } catch (_) {}
        args[key] = val;
      }
      calls.push({
        id: randId(),
        type: "function",
        function: { name: inv[1], arguments: safeJsonString(args) },
      });
    }
  }

  // Pattern 2: <<function:NAME>>{json...}
  if (!calls.length) {
    const fn = text.match(/<<function:([A-Za-z0-9_.:-]+)>>\s*(\{[\s\S]*?\})/);
    if (fn) {
      calls.push({
        id: randId(),
        type: "function",
        function: { name: fn[1], arguments: safeJsonString(fn[2]) },
      });
    }
  }

  // Pattern 3: fenced (or bare) JSON carrying {name, arguments}
  if (!calls.length) {
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const bare = !fenced && text.trim().startsWith("{") ? [text.trim()] : null;
    const cand = fenced ? fenced[1] : bare ? bare[0] : null;
    if (cand && /"name"\s*:/.test(cand) && /"arguments"\s*:/.test(cand)) {
      try {
        const obj = JSON.parse(cand);
        if (obj && obj.name) {
          calls.push({
            id: randId(),
            type: "function",
            function: { name: String(obj.name), arguments: safeJsonString(obj.arguments) },
          });
        }
      } catch (_) {}
    }
  }

  return calls.length ? calls : null;
}

/** Remove a tool-call block from assistant text (Q4 companion). */
function stripToolText(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/<function_calls>[\s\S]*?<\/function_calls>/, "");
  out = out.replace(/```(?:json)?\s*\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}\s*```/, "");
  out = out.replace(/<<function:[^>]+>>\s*\{[\s\S]*?\}/, "");
  const naked = out.trim();
  if (naked.startsWith("{") && naked.endsWith("}")) {
    try {
      const o = JSON.parse(naked);
      if (o && o.name && o.arguments) return "";
    } catch (_) {}
  }
  return out.replace(/[ \t]+$/gm, "").trim();
}

/** Q7: first balanced JSON value out of chatty prose. */
function extractJson(text) {
  if (!text) return text;
  const t = text.replace(/```(?:json)?/g, "").trim();
  for (const open of ["{", "["]) {
    const start = t.indexOf(open);
    if (start === -1) continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
  }
  return text;
}

// ── Upstream request (loopback llama-server / ollama) ─────────
function upstreamChat(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: CFG.backend === "ollama" ? new URL(UPSTREAM_BASE).port || 11434 : CFG.internalPort,
        path: "/v1/chat/completions",
        method: "POST",
        timeout: CFG.timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("upstream_timeout")));
    req.on("error", (e) =>
      resolve({
        status: 599,
        body: JSON.stringify({ error: { message: "upstream: " + e.message } }),
      }),
    );
    req.write(body);
    req.end();
  });
}

function upstreamHealth() {
  return new Promise((resolve) => {
    const req = http.get(UPSTREAM_BASE + "/health", { timeout: 3000 }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => resolve({ ok: res.statusCode === 200, body: buf }));
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: "" });
    });
  });
}

// ── llama-server child management ─────────────────────────────
let child = null;
let shuttingDown = false;
let respawnCount = 0;

function spawnLlamaServer() {
  if (CFG.backend !== "llama") return;
  if (!CFG.llamaBin) {
    log("ERROR", "llama-server binary NOT FOUND - set LLAMA_SERVER_BIN");
    return;
  }
  if (!CFG.gguf || !fs.existsSync(CFG.gguf)) {
    log("ERROR", "GGUF model NOT FOUND - set BRIDGE_GGUF", { gguf: CFG.gguf });
    return;
  }
  const args = [
    "-m", CFG.gguf,
    "-c", String(CFG.ctx),
    "-t", String(CFG.threads),
    "--host", "127.0.0.1",
    "--port", String(CFG.internalPort),
    "--alias", CFG.model,
    "--jinja",
    "--no-webui",
  ];
  log("INFO", "SPAWN llama-server", {
    model: path.basename(CFG.gguf),
    port: CFG.internalPort,
    threads: CFG.threads,
    ctx: CFG.ctx,
  });
  child = spawn(CFG.llamaBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const onData = (d) => {
    for (const line of d.toString().split("\n")) {
      const t = line.trim();
      if (t) log("llama", t.length > 280 ? t.slice(0, 280) + "..." : t);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code, sig) => {
    log("WARN", "llama-server EXITED", { code, sig });
    child = null;
    if (!shuttingDown) {
      respawnCount++;
      const delay = respawnCount > 3 ? 30000 : 3000;
      log("INFO", "respawn in " + delay / 1000 + "s (attempt " + respawnCount + ")");
      setTimeout(spawnLlamaServer, delay);
    }
  });
}

async function waitUpstreamReady(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await upstreamHealth();
    if (h.ok) {
      log("INFO", "UPSTREAM_READY", { base: UPSTREAM_BASE, ms: Date.now() - t0 });
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("WARN", "UPSTREAM_NOT_READY - calls may fail until model loads");
  return false;
}

// ── Response helpers ──────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function openaiError(res, status, message, type) {
  const payload = JSON.stringify({
    error: { message: message, type: type || "bridge_error", code: null },
  });
  if (!res.headersSent) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
  }
  res.end(payload);
}

function readBody(req, max) {
  max = max || 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > max) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Non-stream pipeline (Q2/Q3/Q4/Q5/Q6/Q7/Q8) ───────────────
function buildPayload(body, stream) {
  const p = {
    model: CFG.upstreamModel,
    messages: body.messages,
    stream: !!stream,
    temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
    // llama-server prompt cache: repeated big system prompts skip re-prefill
    cache_prompt: true,
  };
  if (typeof body.max_tokens === "number") p.max_tokens = body.max_tokens;
  if (body.stop) p.stop = body.stop;
  if (body.response_format) p.response_format = body.response_format;
  if (Array.isArray(body.tools) && body.tools.length) p.tools = body.tools;
  if (body.tool_choice) p.tool_choice = body.tool_choice;
  return p;
}

function toolHintSystem(tools) {
  const fns = (tools || []).map((t) => t && t.function).filter((f) => f && f.name);
  const spec = JSON.stringify(fns);
  let example = '{"name":"tool","arguments":{}}';
  const first = fns[0];
  if (first) {
    const props = (first.parameters && first.parameters.properties) || {};
    const keys = Object.keys(props).slice(0, 3);
    const args = {};
    for (const k of keys) args[k] = "example";
    example = JSON.stringify({ name: first.name, arguments: args });
  }
  return (
    "Available tools (JSON):\n" + spec + "\n\n" +
    "To use a tool, reply with ONLY this exact shape and nothing else " +
    "(no prose, no explanation):\n```json\n" + example + "\n```"
  );
}

function normalizeUpstream(parsed) {
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const m = choice.message || {};
  let content = typeof m.content === "string" ? m.content : "";
  let reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
  let toolCalls =
    Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : null;

  const st = stripThink(content);
  content = st.content;
  if (st.stripped) reasoning = (reasoning ? reasoning + "\n" : "") + st.stripped;

  if (!toolCalls) {
    toolCalls = parseToolCalls(content);
    if (toolCalls) content = stripToolText(content); // keep chat UI clean
  }

  return {
    content: content,
    reasoning: reasoning.trim(),
    toolCalls: toolCalls,
    finish: choice.finish_reason || "stop",
    rawChoice: choice,
  };
}

async function chatNonStream(body, transport) {
  const t0 = Date.now();
  const wantModel = typeof body.model === "string" && body.model ? body.model : CFG.model;
  const hadTools = Array.isArray(body.tools) && body.tools.length > 0;
  const payload0 = buildPayload(body, false);

  let stage = "direct";
  let up = await upstreamChat(payload0);
  let payloadUsed = payload0;

  // Q6: ANY upstream failure while tools were sent (template/grammar/
  // peg errors from local backends) -> retry once WITHOUT tools, with
  // a JSON-tool hint system so Q4 can still parse a text tool call.
  if (up.status !== 200 && hadTools) {
    stage = "toolstrip_retry";
    log("WARN", "TOOLSTRIP_RETRY backend rejected tools - retrying with hint", {
      status: up.status,
      head: up.body.slice(0, 160),
    });
    const p2 = buildPayload({ ...body, tools: undefined, tool_choice: undefined }, false);
    p2.messages = [
      { role: "system", content: toolHintSystem(body.tools) },
    ].concat(body.messages);
    payloadUsed = p2;
    up = await upstreamChat(p2);
  }

  if (up.status !== 200) {
    let msg = "upstream HTTP " + up.status;
    try {
      const e = JSON.parse(up.body);
      if (e && e.error && e.error.message) msg = e.error.message;
    } catch (_) {}
    log("ERROR", "UPSTREAM_FAIL", { status: up.status, stage: stage, msg: msg.slice(0, 200) });
    return {
      ok: false,
      status: up.status >= 400 && up.status < 600 ? up.status : 502,
      message: msg,
      type: "upstream_error",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(up.body);
  } catch (_) {
    return { ok: false, status: 502, message: "upstream returned non-JSON", type: "upstream_error" };
  }

  let norm = normalizeUpstream(parsed);

  // Q5: empty reply while tools were sent -> one retry WITHOUT tools
  if (!norm.content && !norm.toolCalls && hadTools && stage === "direct") {
    stage = "empty_retry";
    log("WARN", "EMPTY_RETRY empty reply with tools - retrying without tools");
    const p2 = buildPayload({ ...body, tools: undefined, tool_choice: undefined }, false);
    payloadUsed = p2;
    const up2 = await upstreamChat(p2);
    if (up2.status === 200) {
      try {
        const p = JSON.parse(up2.body);
        const n2 = normalizeUpstream(p);
        if (n2.content || n2.toolCalls) {
          parsed = p;
          norm = n2;
        }
      } catch (_) {}
    }
  }

  // Q7: json_object mode -> keep only the JSON
  if (body.response_format && body.response_format.type === "json_object" && norm.content) {
    norm.content = extractJson(norm.content);
  } else if (norm.content && /```json[\s\S]*```/.test(norm.content)) {
    const ex = extractJson(norm.content);
    if (ex !== norm.content) norm.content = ex;
  }

  const message = { role: "assistant", content: norm.toolCalls ? norm.content || "" : norm.content };
  if (norm.reasoning) message.reasoning_content = norm.reasoning;
  if (norm.toolCalls) message.tool_calls = norm.toolCalls;

  // Q8: usage fill, honestly flagged as estimated
  let usage = parsed.usage;
  let estimated = false;
  if (!usage || typeof usage.total_tokens !== "number") {
    estimated = true;
    const promptChars = JSON.stringify(payloadUsed.messages).length;
    const outChars = norm.content.length + norm.reasoning.length;
    usage = {
      prompt_tokens: Math.ceil(promptChars / 4),
      completion_tokens: Math.ceil(outChars / 4),
      total_tokens: Math.ceil(promptChars / 4) + Math.ceil(outChars / 4),
      estimated: true,
    };
  }

  const response = {
    id: parsed.id || "chatcmpl-bridge-" + crypto.randomBytes(8).toString("hex"),
    object: "chat.completion",
    created: parsed.created || Math.floor(Date.now() / 1000),
    model: wantModel,
    choices: [
      {
        index: 0,
        message: message,
        finish_reason: norm.toolCalls ? "tool_calls" : norm.finish || "stop",
      },
    ],
    usage: usage,
  };

  log("INFO", "CHAT_OK", {
    transport: transport,
    model: wantModel,
    stage: stage,
    ms: Date.now() - t0,
    tools: hadTools ? body.tools.length : 0,
    tool_calls: norm.toolCalls ? norm.toolCalls.length : 0,
    content_chars: norm.content.length,
    finish: response.choices[0].finish_reason,
    usage_total: usage.total_tokens,
    usage_estimated: estimated || undefined,
  });
  return { ok: true, response: response };
}

// ── Stream pipeline (Q9 + Q3 filter + Q2 stamp) ───────────────
async function chatStream(body, req, res, transport) {
  const t0 = Date.now();
  const wantModel = typeof body.model === "string" && body.model ? body.model : CFG.model;
  const payload = buildPayload(body, true);
  const bodyStr = JSON.stringify(payload);
  const stamp = "chatcmpl-bridge-" + crypto.randomBytes(8).toString("hex");
  const now = Math.floor(Date.now() / 1000);

  const port =
    CFG.backend === "ollama" ? parseInt(new URL(UPSTREAM_BASE).port || "11434", 10) : CFG.internalPort;

  const upReq = http.request(
    {
      hostname: "127.0.0.1",
      port: port,
      path: "/v1/chat/completions",
      method: "POST",
      timeout: CFG.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        let buf = "";
        upRes.on("data", (d) => (buf += d));
        upRes.on("end", () => {
          let msg = "upstream HTTP " + upRes.statusCode;
          try {
            const e = JSON.parse(buf);
            if (e && e.error && e.error.message) msg = e.error.message;
          } catch (_) {}
          log("ERROR", "STREAM_UPSTREAM_FAIL", {
            status: upRes.statusCode,
            msg: msg.slice(0, 200),
          });
          openaiError(
            res,
            upRes.statusCode >= 400 && upRes.statusCode < 600 ? upRes.statusCode : 502,
            msg,
            "upstream_error",
          );
        });
        return;
      }

      cors(res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const filter = makeThinkFilter();
      let sawDone = false;
      let lastBeat = Date.now();
      let buf = "";
      let bytes = 0;

      // Q9 heartbeat: stops client idle-timeouts on slow CPU inference
      const hb = setInterval(() => {
        if (Date.now() - lastBeat >= 15000) {
          try {
            res.write(": hb\n\n");
            lastBeat = Date.now();
          } catch (_) {}
        }
      }, 5000);

      const finish = (why) => {
        clearInterval(hb);
        if (!sawDone) {
          try {
            res.write("data: [DONE]\n\n");
          } catch (_) {}
        }
        try {
          res.end();
        } catch (_) {}
        log("INFO", "CHAT_STREAM_OK", {
          transport: transport,
          model: wantModel,
          ms: Date.now() - t0,
          bytes: bytes,
          why: why || "end",
        });
      };

      upRes.setEncoding("utf8");
      upRes.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            sawDone = true;
            try {
              res.write("data: [DONE]\n\n");
              bytes += 15;
            } catch (_) {}
            lastBeat = Date.now();
            continue;
          }
          let obj;
          try {
            obj = JSON.parse(data);
          } catch (_) {
            continue;
          }
          // Q2 + Q9: stamp identity fields on every chunk
          obj.id = obj.id || stamp;
          obj.created = obj.created || now;
          obj.model = obj.model || wantModel;
          if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
            const d = obj.choices[0].delta;
            if (typeof d.content === "string" && d.content.length) {
              const out = filter.push(d.content);
              const hasOther =
                !!d.role || (Array.isArray(d.tool_calls) && d.tool_calls.length);
              if (!out && !hasOther) continue; // pure reasoning chunk, dropped
              d.content = out;
            }
          }
          try {
            const line2 = "data: " + JSON.stringify(obj) + "\n\n";
            res.write(line2);
            bytes += line2.length;
            lastBeat = Date.now();
          } catch (_) {}
        }
      });
      upRes.on("end", () => finish("upstream_end"));
      upRes.on("error", (e) => {
        log("WARN", "STREAM_UPSTREAM_ERROR", { error: e.message });
        try {
          res.write(
            "data: " +
              JSON.stringify({ error: { message: "upstream: " + e.message, type: "upstream_error" } }) +
              "\n\n",
          );
        } catch (_) {}
        finish("upstream_error");
      });
    },
  );

  upReq.on("timeout", () => upReq.destroy(new Error("upstream_timeout")));
  upReq.on("error", (e) => {
    log("ERROR", "STREAM_CONNECT_FAIL", { error: e.message });
    openaiError(res, 502, "upstream: " + e.message, "upstream_error");
  });
  req.on("aborted", () => {
    try {
      upReq.destroy();
    } catch (_) {}
  });
  upReq.write(bodyStr);
  upReq.end();
}

// ── HTTP handler (shared by TCP + Unix socket) ────────────────
async function handler(req, res) {
  const isUDS = !!(req.socket && req.socket._isBridgeUDS);
  const transport = isUDS ? "uds" : "tcp";
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    const h = await upstreamHealth();
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        bridge: "local-llm-bridge",
        backend: CFG.backend,
        model: CFG.model,
        gguf: CFG.gguf && fs.existsSync(CFG.gguf) ? path.basename(CFG.gguf) : null,
        upstream: { base: UPSTREAM_BASE, ready: h.ok },
        transports: { unix_socket: CFG.socket, tcp: "127.0.0.1:" + CFG.port },
        auth_required: false,
      }),
    );
    return;
  }

  if (req.method === "GET" && url === "/v1/models") {
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: CFG.model,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "local-llm-bridge",
          },
        ],
      }),
    );
    return;
  }

  if (req.method === "POST" && url === "/v1/chat/completions") {
    let body;
    try {
      const raw = await readBody(req);
      try {
        body = JSON.parse(raw);
      } catch (_) {
        openaiError(res, 400, "invalid JSON body", "invalid_request_error");
        return;
      }
    } catch (e) {
      openaiError(
        res,
        e.message === "body_too_large" ? 413 : 400,
        e.message,
        "invalid_request_error",
      );
      return;
    }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      openaiError(res, 400, "non-empty messages array is required", "invalid_request_error");
      return;
    }
    log("INFO", "REQ", {
      transport: transport,
      model: body.model || "(none)",
      stream: !!body.stream,
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      messages: body.messages.length,
    });
    try {
      if (body.stream) {
        await chatStream(body, req, res, transport);
      } else {
        const out = await chatNonStream(body, transport);
        if (!out.ok) {
          openaiError(res, out.status, out.message, out.type);
          return;
        }
        cors(res);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.response));
      }
    } catch (e) {
      log("ERROR", "HANDLER_CRASH", {
        error: e.message,
        stack: (e.stack || "").split("\n")[1],
      });
      openaiError(res, 500, "bridge: " + e.message, "bridge_error");
    }
    return;
  }

  openaiError(
    res,
    404,
    "local-llm-bridge: no route for " + req.method + " " + url +
      " (serves /health, /v1/models, /v1/chat/completions)",
    "invalid_request_error",
  );
}

// ── Dual bind + lifecycle ─────────────────────────────────────
function start() {
  log("INFO", "=====================================================");
  const hintNow = process.env.BRIDGE_GGUF_HINT;
  if (hintNow && CFG.gguf && !CFG.gguf.includes(hintNow)) {
    log("WARN", "HINT_NO_MATCH", {
      hint: hintNow,
      using: path.basename(CFG.gguf),
      note: "no gguf matched the hint - fell back to the newest file",
    });
  }
  log("INFO", "LOCAL LLM BRIDGE STARTING", {
    backend: CFG.backend,
    model: CFG.model,
    gguf: CFG.gguf && fs.existsSync(CFG.gguf) ? path.basename(CFG.gguf) : "MISSING",
    llama_bin: CFG.llamaBin || "MISSING",
    threads: CFG.threads,
    ctx: CFG.ctx,
  });

  try {
    if (fs.existsSync(CFG.socket)) fs.unlinkSync(CFG.socket);
  } catch (_) {}

  if (CFG.backend === "llama") spawnLlamaServer();

  const tcp = http.createServer(handler);
  tcp.on("error", (e) => log("ERROR", "TCP_BIND_FAIL", { port: CFG.port, error: e.message }));
  tcp.listen(CFG.port, "127.0.0.1", () => {
    log("INFO", "TCP_LISTEN", { url: "http://127.0.0.1:" + CFG.port });
  });

  const uds = http.createServer(handler);
  uds.on("connection", (sock) => (sock._isBridgeUDS = true));
  uds.on("error", (e) => log("ERROR", "UDS_BIND_FAIL", { socket: CFG.socket, error: e.message }));
  uds.listen(CFG.socket, () => {
    try {
      fs.chmodSync(CFG.socket, 0o666);
    } catch (_) {}
    log("INFO", "UDS_LISTEN", { socket: CFG.socket, perm: "0666" });
  });

  waitUpstreamReady(120000).then((ok) => {
    log("INFO", ok ? "READY" : "READY_DEGRADED upstream not up yet", {
      tcp: "http://127.0.0.1:" + CFG.port + "/v1",
      uds: "unix://" + CFG.socket,
      note: "no auth required - any local client",
    });
  });

  const shutdown = (sig) => {
    shuttingDown = true;
    log("INFO", "SHUTDOWN", { sig: sig });
    try {
      if (child) child.kill("SIGTERM");
    } catch (_) {}
    try {
      tcp.close();
      uds.close();
    } catch (_) {}
    try {
      if (fs.existsSync(CFG.socket)) fs.unlinkSync(CFG.socket);
    } catch (_) {}
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start();
