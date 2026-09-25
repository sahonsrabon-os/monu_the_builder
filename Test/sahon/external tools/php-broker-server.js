#!/usr/bin/env node
/**
 * php-broker-server.js — Mission Barisal PHP Broker Server (দালালি সার্ভার)
 * ============================================================
 * A zero-dependency Node.js backend that replicates index.live.php
 * EXACTLY — same wire format, same ai_php_api actions, same JSON
 * shapes — so the frontend (allindex.live.php) works unchanged.
 *
 * Wire format (identical to PHP backend):
 *   GET/POST {BROKER_URL}?act=ai&path={PROJECT}&project_id={PID}
 *                       &ai_php_api={ACTION}&csrf_token={TOKEN}
 *   POST body: application/x-www-form-urlencoded
 *   Streaming: {BROKER_URL}?act=ai&ai_chat_stream=1 → SSE to sarver
 *
 * Static assets from the frontend/public/ folder are served so the
 * UI is fully standalone (no CDN needed).
 *
 * Env config:
 *   BROKER_PORT        (default 9998)
 *   BROKER_HOST        (default 127.0.0.1 — set 0.0.0.0 only for a remote frontend)
 *   SARVER_URL         (default http://localhost:<PORT>)
 *   FRONTEND_DIR       (default ../frontend)
 *   BROKER_TIMEOUT_MS  (default 120000)
 */
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const PORT = parseInt(process.env.BROKER_PORT || "9998", 10);
// Bind host — loopback by default. The broker is spawned by start.js on the
// same machine as the main server and has NO auth, so it must not be exposed
// by default. NOTE: a REMOTE PHP frontend (see the "even a remote host"
// comment in the API-only section below) would need an explicit LAN/0.0.0.0
// bind — set BROKER_HOST=0.0.0.0 (or a LAN IP) only in that setup.
const HOST = process.env.BROKER_HOST || "127.0.0.1";

// ─── .env loader (search upward: external tools → sarver → softaculous) ───
// Mirrors start.js loadEnv() so the broker can be started with a plain
// `node php-broker-server.js` — no env-prefix needed. brokerUrl in .env
// configures the upstream SARVER_URL for the whole system.
function loadDotEnv() {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const envPath = path.join(dir, ".env");
    if (fs.existsSync(envPath)) {
      try {
        const content = fs.readFileSync(envPath, "utf8");
        for (const line of content.split("\n")) {
          const t = line.trim();
          if (!t || t.startsWith("#")) continue;
          const eq = t.indexOf("=");
          if (eq === -1) continue;
          const k = t.slice(0, eq).trim();
          const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
          if (k && process.env[k] === undefined) process.env[k] = v;
        }
        console.log("[ENV] Loaded: " + envPath);
      } catch (e) { /* ignore */ }
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
}
loadDotEnv();

// Also load frontend/.env (broker URL + PHP port) so the broker can
// verify its connection with the PHP frontend server.
(function loadFrontendEnv() {
  const fe = path.resolve(__dirname, "..", "..", "frontend", ".env");
  if (fs.existsSync(fe)) {
    try {
      const content = fs.readFileSync(fe, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (k && process.env[k] === undefined) process.env[k] = v;
      }
      console.log("[ENV] Loaded: " + fe);
    } catch (e) { /* ignore */ }
  }
})();

// Sarver (api.js) listens on PORT (env-driven). SARVER_URL / brokerUrl win;
// otherwise fall back to the env-driven main port — never a hardcoded one.
const SARVER_URL =
  process.env.SARVER_URL ||
  process.env.brokerUrl ||
  "http://localhost:" + (process.env.PORT || "9999");
const FRONTEND_PORT = process.env.FRONTEND_PORT || "8081";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:" + FRONTEND_PORT;
// Allowed CORS origins — comma-separated. Always includes FRONTEND_URL
// (plus any ALLOWED_ORIGINS from env). The broker echoes the request
// Origin header (so it "knows where the request came from") when it is
// in this allow-list, else falls back to *.
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
if (FRONTEND_URL) ALLOWED_ORIGINS.add(FRONTEND_URL);

// Pick the CORS origin to echo based on the request's Origin header.
function corsOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin && (ALLOWED_ORIGINS.has(origin) || ALLOWED_ORIGINS.has("*"))) {
    return origin;
  }
  return "*";
}
const FRONTEND_DIR = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.resolve(__dirname, "..", "..", "frontend");
// OS default root — the "home" directory shown in the project
// modal and used as the base for relative project paths. Varies
// by OS: Linux /home/<user>, Windows C:\Users\<user>, macOS
// /Users/<user>. Override with OS_ROOT env if needed.
const OS_ROOT = process.env.OS_ROOT
  ? path.resolve(process.env.OS_ROOT)
  : os.homedir();
const TIMEOUT_MS = parseInt(process.env.BROKER_TIMEOUT_MS || "120000", 10);

// ─── Local file-based storage (mirrors PHP __DIR__/.json files) ───
const STORE = {
  session: path.join(FRONTEND_DIR, ".session.json"),
  projects: path.join(FRONTEND_DIR, ".projects.json"),
  favorites: path.join(FRONTEND_DIR, ".favorites.json"),
  conversations: path.join(FRONTEND_DIR, ".conversations.json"),
};

function readJson(file, def) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed || def;
    }
  } catch (e) { /* ignore */ }
  return def;
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { /* ignore */ }
}

// ─── HTTP helper (zero-dep) to proxy to sarver ───
function proxyToSarver(pathname, query = {}, postData = null) {
  return new Promise((resolve) => {
    const u = new URL(SARVER_URL + pathname);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const lib = u.protocol === "https:" ? https : http;
    const headers = { Accept: "application/json" };
    if (postData) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const req = lib.request(
      u,
      { method: postData ? "POST" : "GET", headers, timeout: TIMEOUT_MS },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(buf); } catch (e) { parsed = null; }
          if (parsed === null && buf !== "null") {
            resolve({ error: "invalid sarver response", code: 502, raw: buf.slice(0, 500) });
          } else {
            resolve({ data: parsed, code: res.statusCode });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: "sarver unreachable: " + e.message, code: 502 }));
    if (postData) req.write(postData);
    req.end();
  });
}

// ─── Provider list builder (shared by "providers" and "status") ───
function getProviders() {
  return proxyToSarver("/api/v0/models", { t: Date.now() }).then((r) => {
    if (r.error) {
      // Fallback: known providers so UI still renders
      return [
        { id: "missionbarisal", name: "Mission Barisal", connected: true,
          models: { mission: "Mission (All Agents)", "code-guru": "Code Guru - Monu",
            "bug-hunter": "Bug Hunter - Jewel", "security-hero": "Security Hero - Bablu",
            "perf-wizard": "Performance Wizard - Rashed", "doc-king": "Documentation King - Halim",
            "qa-tyrant": "Quality Tyrant - Mojnu", "team-heart": "Team Heart - Jara" } },
        { id: "opencode", name: "OpenCode", connected: true, models: {} },
        { id: "groq", name: "Groq", connected: true, models: {} },
        { id: "gemini", name: "Gemini", connected: true, models: {} },
      ];
    }
    const models = (r.data && r.data.data) || [];
    const byOwner = {};
    const agents = [];
    for (const m of models) {
      const owner = m.owned_by || "unknown";
      const mid = m.id || "";
      if (owner === "mission-barisal") agents.push(mid);
      else { if (!byOwner[owner]) byOwner[owner] = []; byOwner[owner].push(mid); }
    }
    const agentModels = {};
    for (const aid of agents) {
      const clean = String(aid).replace(/^mission:/, "");
      agentModels[clean] = clean;
    }
    const providers = [{ id: "missionbarisal", name: "Mission Barisal", connected: true, models: agentModels }];
    for (const [ownerName, mids] of Object.entries(byOwner)) {
      const pid = ownerName.toLowerCase().replace(/[^a-zA-Z0-9]/g, "");
      if (pid === "missionbarisal") {
        for (const mid of mids) agentModels[mid] = mid;
        providers[0].models = agentModels;
        continue;
      }
      const modelsMap = {};
      for (const mid of mids) modelsMap[mid] = mid;
      providers.push({ id: pid, name: ownerName, connected: true, models: modelsMap });
    }
    return providers;
  });
}

// ─── JSON helpers (mirror jsonOut/jsonErr) ───
function jsonOut(res, data, code = 200) {
  // Guard: if the response already started (e.g. SSE streaming began,
  // then an upstream error fires), we can't writeHead again — that
  // would throw ERR_HTTP_HEADERS_SENT and kill the whole broker.
  if (res.headersSent || res.writableEnded) {
    try { res.end(); } catch (e) {}
    return;
  }
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": res._corsOrigin || "*",
  });
  res.end(body);
}

function jsonErr(res, msg, code = 400) {
  jsonOut(res, { error: msg }, code);
}

// ─── Build tree (mirror PHP buildTree) ───
function isDirSafe(p) {
  // PHP's is_dir() returns false for broken symlinks (no crash).
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function buildTree(base, depth) {
  const items = [];
  try {
    if (!fs.existsSync(base) || !isDirSafe(base)) return items;
  } catch (e) { return items; }
  let entries;
  try { entries = fs.readdirSync(base); } catch (e) { return items; }
  const skip = new Set([".git", "node_modules", "vendor", "cache", "logs"]);
  for (const e of entries) {
    if (e === "." || e === "..") continue;
    if (skip.has(e)) continue;
    const full = path.join(base, e);
    const isDir = isDirSafe(full);
    const item = { name: e, path: full, type: isDir ? "dir" : "file" };
    if (isDir && depth > 0) item.children = buildTree(full, depth - 1);
    items.push(item);
  }
  return items;
}

// ─── Static asset serving (frontend/public) ───
const MIME = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

function serveStatic(req, res, url) {
  const publicDir = path.join(FRONTEND_DIR, "public");
  let rel = url.pathname.replace(/^\/public\//, "/");
  if (url.pathname === "/") rel = "/allindex.live.php";
  let filePath = path.join(publicDir, rel);
  // Also serve allindex.live.php directly
  if (url.pathname === "/" || url.pathname === "/allindex.live.php") {
    filePath = path.join(FRONTEND_DIR, "allindex.live.php");
  }
  if (!filePath.startsWith(publicDir) && !filePath.startsWith(FRONTEND_DIR)) {
    jsonErr(res, "Forbidden", 403);
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    jsonErr(res, "Not found", 404);
    return;
  }
  const ext = path.extname(filePath);
  const type = MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  fs.createReadStream(filePath).pipe(res);
}

// ─── ai_php_api dispatch (mirror index.live.php EXACTLY) ───
// PHP semantics: $_GET['path'] returns the LAST value when the same
// key appears multiple times (UI appends a 2nd path for file_tree).
function phpGet(params, k) {
  const all = params.getAll(k);
  return all.length ? all[all.length - 1] : "";
}

function handleApi(req, res, url, params, body) {
  const api = params.get("ai_php_api") || "";
  const pathParam = params.get("path") || "";
  const projectId = params.get("project_id") || "";
  const csrf = params.get("csrf_token") || "";
  const get = (k) => phpGet(params, k) || (body[k] !== undefined ? body[k] : "");

  switch (api) {
    // ── Providers & models ──
    case "providers": {
      getProviders().then((providers) => jsonOut(res, providers));
      return;
    }

    // ── Conversations list ──
    case "conversations": {
      proxyToSarver("/api/sessions", { t: Date.now() }).then((r) => {
        let list = [];
        // Sarver /api/sessions returns { total, active, sessions: [...] } —
        // wrap it in { data } so r.data is the object, sessions is the array.
        if (!r.error && r.data) {
          let sessions = r.data.sessions || r.data;
          if (Array.isArray(sessions)) {
            for (const s of sessions) {
              let msgCount = 0;
              if (s.messages) {
                if (Array.isArray(s.messages)) msgCount = s.messages.length;
                else if (typeof s.messages === "number") msgCount = s.messages;
              }
              list.push({
                id: s.id || "",
                title: s.title || "Untitled",
                updated_at: typeof s.updated_at === "number" ? s.updated_at : (s.updated_at ? Date.parse(s.updated_at) / 1000 : Math.floor(Date.now() / 1000)),
                message_count: msgCount,
                mode: s.mode || "build",
              });
            }
          }
        }
        if (!list.length) {
          list = readJson(STORE.conversations, []);
        }
        jsonOut(res, list);
      });
      return;
    }

    // ── Load a conversation ──
    case "conversation": {
      const cid = get("conversation_id");
      proxyToSarver("/api/conversation/" + encodeURIComponent(cid), { t: Date.now() }).then((r) => {
        if (r.error) { jsonOut(res, { error: "not found", messages: [] }); return; }
        const data = r.data || {};
        jsonOut(res, { id: cid, messages: data.messages || [] });
      });
      return;
    }

    // ── Status ──
    case "status": {
      const session = readJson(STORE.session, null) || {
        provider: "missionbarisal", model: "mission", mode: "build",
        variant: "default", active_conversation: "",
      };
      // Frontend checks d.providers.some(p => p.connected) to show "Ready".
      getProviders().then((providers) => {
        jsonOut(res, { session, providers });
      });
      return;
    }

    // ── Project info ──
    case "project_info": {
      jsonOut(res, {
        name: pathParam || "OS Root",
        path: pathParam || OS_ROOT,
        id: projectId,
        root: OS_ROOT,
        type: "auto",
      });
      return;
    }

    // ── Projects list ──
    case "projects_list": {
      let list = readJson(STORE.projects, []);
      if (!list.length && pathParam) {
        list.push({ project_id: projectId, name: pathParam, path: pathParam || OS_ROOT, active: true });
      }
      jsonOut(res, list);
      return;
    }

    // ── Create project (UI calls api('projects_create', {...})) ──
    case "projects_create": {
      const name = get("name") || "untitled";
      const path = get("path") || OS_ROOT;
      const type = get("type") || "custom";
      const insid = get("insid") || "";
      // Generate a unique project_id (the whole system keys params
      // off project_id, so it MUST be present).
      const projectId = "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
      try {
        if (!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
      } catch (e) { /* ignore — dir may be read-only or already exist */ }
      let list = readJson(STORE.projects, []);
      const proj = { project_id: projectId, name, path, type, insid, active: true };
      list.push(proj);
      writeJson(STORE.projects, list);
      jsonOut(res, { project_id: projectId, name, path, type, insid });
      return;
    }

    // ── Delete project (UI calls api('projects_delete', {...})) ──
    case "projects_delete": {
      const pid = get("project_id") || "";
      let list = readJson(STORE.projects, []);
      list = list.filter((p) => (p.project_id || p.id) !== pid);
      writeJson(STORE.projects, list);
      jsonOut(res, { success: true });
      return;
    }

    // ── Set working dir (UI calls api('set_working_dir', {directory})) ──
    // Proxies to sarver POST /api/set-working-dir → mcpWorkingDir + autoSSOT
    case "set_working_dir": {
      const directory = get("directory") || get("path") || "";
      if (!directory) { jsonErr(res, "Missing directory"); return; }
      const lib = SARVER_URL.startsWith("https") ? https : http;
      const u = new URL(SARVER_URL + "/api/set-working-dir");
      const body = JSON.stringify({ directory, client: "frontend" });
      const req2 = lib.request(u, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: TIMEOUT_MS,
      }, (r2) => {
        let buf = "";
        r2.on("data", (c) => (buf += c));
        r2.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(buf); } catch (e) { parsed = null; }
          if (parsed) { jsonOut(res, parsed); }
          else { jsonOut(res, { success: false, error: "invalid sarver response", raw: buf.slice(0, 300) }); }
        });
      });
      req2.on("timeout", () => req2.destroy(new Error("timeout")));
      req2.on("error", (e) => jsonErr(res, "sarver unreachable: " + e.message, 502));
      req2.write(body);
      req2.end();
      return;
    }

    // ── Settings load ──
    case "settings_load": {
      jsonOut(res, { favorite_models: readJson(STORE.favorites, []) });
      return;
    }

    // ── Settings save / favorite model ──
    case "settings_save":
    case "favorite_model": {
      const modelId = body.model_id || "";
      let favorites = readJson(STORE.favorites, []);
      if (api === "favorite_model") {
        if (!favorites.includes(modelId)) favorites.push(modelId);
      } else if (api === "settings_save") {
        if (Array.isArray(body.favorite_models)) favorites = body.favorite_models;
      }
      writeJson(STORE.favorites, favorites);
      jsonOut(res, { ok: true, favorite_models: favorites });
      return;
    }

    // ── File tree ──
    case "file_tree": {
      let dir = get("path") || OS_ROOT;
      const depth = parseInt(get("depth") || "1", 10);
      const root = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
      jsonOut(res, { path: root, tree: buildTree(root, depth) });
      return;
    }

    // ── Read file ──
    case "read_file": {
      const file = get("path");
      if (!file || !fs.existsSync(file)) { jsonErr(res, "File not found"); return; }
      jsonOut(res, { path: file, content: fs.readFileSync(file, "utf8") });
      return;
    }

    // ── Resolve file ──
    case "resolve_file": {
      const file = get("path");
      if (!file) { jsonErr(res, "No path"); return; }
      jsonOut(res, { path: file, resolved: fs.existsSync(file) ? fs.realpathSync(file) : file });
      return;
    }

    // ── Shell ──
    case "shell": {
      const cmd = body.command || "";
      if (!cmd) { jsonOut(res, { output: "", error: "No command", returncode: 1 }); return; }
      const fullCmd = "cd " + JSON.stringify(OS_ROOT).replace(/"/g, "'") + " 2>/dev/null; " + cmd + " 2>&1";
      exec(fullCmd, { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
        jsonOut(res, { output: stdout + (stderr ? "\n" + stderr : ""), error: err ? err.message : "", returncode: err ? (err.code || 1) : 0 });
      });
      return;
    }

    // ── Set mode ──
    case "set_mode": {
      jsonOut(res, { ok: true, mode: body.mode || "build" });
      return;
    }

    // ── Clear ──
    case "clear": {
      jsonOut(res, { ok: true });
      return;
    }

    // ── New session ──
    case "new_session": {
      const crypto = require("crypto");
      const newId = crypto.randomBytes(16).toString("hex");
      jsonOut(res, { id: newId, session_id: newId });
      return;
    }

    // ── Start / switch / delete conversation ──
    case "start":
    case "switch_conversation":
    case "delete_conversation": {
      jsonOut(res, { ok: true });
      return;
    }

    default: {
      jsonErr(res, "Unknown action: " + api, 404);
    }
  }
}

// ─── Parse request body (application/x-www-form-urlencoded) ───
function parseBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      const out = {};
      if (buf) {
        try {
          for (const [k, v] of new URLSearchParams(buf)) out[k] = v;
        } catch (e) { /* ignore */ }
      }
      resolve(out);
    });
  });
}

// ─── HTTP server ───
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:" + PORT);
  const params = url.searchParams;

  // CORS — echo the request Origin so the broker "knows where the
  // request came from" and answers with the right header.
  const _origin = corsOrigin(req);
  res._corsOrigin = _origin;
  res.setHeader("Access-Control-Allow-Origin", _origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, X-API-Key, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Request log (for testing/browser proof)
  const _api = params.get("ai_php_api") || (url.pathname === "/" ? "UI" : url.pathname);
  console.log("[" + new Date().toISOString() + "] " + req.method + " " + url.pathname + "?act=" + (params.get("act")||"") + "&ai_php_api=" + _api + "&path=" + (params.get("path")||""));

  const body = await parseBody(req);
  const act = params.get("act") || "";

  // ── Broker is API-ONLY ──
  // The PHP frontend runs on its OWN PHP server (php -S), anywhere
  // (even a remote host). It calls THIS broker cross-origin (CORS is
  // open via Access-Control-Allow-Origin: *). The broker does NOT
  // open/serve the PHP — it only handles the API responses.
  const isBrokerApi = url.pathname === "/index.live.php" || url.pathname.startsWith("/api/");
  if (!isBrokerApi || act !== "ai") {
    jsonErr(res, "Not found", 404);
    return;
  }

  // ai_chat_stream → SSE proxy to sarver
  if (params.get("ai_chat_stream") || body.ai_chat_stream) {
    const streamUrl = SARVER_URL + "/v1/chat/completions";
    // Sarver /v1/chat/completions expects OpenAI format:
    //   { messages: [{role, content}], session_id, model, stream }
    // The frontend sends {content, conversation_id, model} — convert
    // so the mission actually receives the user's text (was empty →
    // "Input must be a non-empty string" in the anti-dote monitor).
    const postData = JSON.stringify({
      messages: [{ role: "user", content: body.content || "" }],
      session_id: body.conversation_id || "",
      model: body.model || "mission",
      stream: true,
    });
    const u = new URL(streamUrl);
    const lib = u.protocol === "https:" ? https : http;
    const headers = { "Content-Type": "application/json", "Accept": "text/event-stream" };
    const req2 = lib.request(u, { method: "POST", headers, timeout: TIMEOUT_MS }, (r2) => {
      // Client may disconnect mid-stream (browser tab closed, network
      // drop, user navigates away). Without this handler, res.write()
      // emits an unhandled 'error' event on the response stream →
      // process crash (exit code 1). This is a NORMAL condition, not a
      // server bug. Tear down the upstream request too.
      res.on("error", () => { req2.destroy(); });
      if (res.writableEnded || res.destroyed) {
        req2.destroy(new Error("client disconnected"));
        return;
      }
      res.writeHead(r2.statusCode || 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": corsOrigin(req),
      });
      // ── Convert sarver's OpenAI SSE chunks → frontend `_event`
      // format. The UI (allindex.live.php ~1515) ONLY renders events
      // with `_event` in {"text-delta","reasoning-delta","tool-call",
      // "tool-result"} — raw OpenAI `delta.content` chunks are ignored.
      let sseBuf = "";
      r2.on("data", (c) => {
        sseBuf += c.toString("utf8");
        const lines = sseBuf.split("\n");
        sseBuf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(payload); } catch (e) { continue; }
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          const content = delta ? delta.content || "" : "";
          if (content && !res.writableEnded && !res.destroyed) {
            try {
              res.write("data: " + JSON.stringify({ _event: "text-delta", text: content }) + "\n\n");
            } catch (err) { req2.destroy(); return; }
          }
        }
      });
      r2.on("end", () => {
        if (res.writableEnded || res.destroyed) return;
        try {
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err) {}
      });
      r2.on("error", () => { try { res.end(); } catch (err) {} });
    });
    req2.on("timeout", () => req2.destroy(new Error("timeout")));
    req2.on("error", (e) => {
      // If headers already sent (SSE streaming started) OR the client
      // already disconnected, a 502 jsonErr would crash with
      // ERR_HTTP_HEADERS_SENT / EPIPE. Just close the stream.
      if (res.headersSent || res.writableEnded || res.destroyed) {
        try { res.end(); } catch (err) {}
        return;
      }
      jsonErr(res, "sarver unreachable: " + e.message, 502);
    });
    req2.write(postData);
    req2.end();
    return;
  }

  handleApi(req, res, url, params, body);
});

server.listen(PORT, HOST, () => {
  console.log("php-broker-server (দালালি সার্ভার) listening on http://" + HOST + ":" + PORT);
  console.log("  SARVER_URL   = " + SARVER_URL);
  console.log("  FRONTEND_DIR = " + FRONTEND_DIR);
  console.log("  OS_ROOT      = " + OS_ROOT);
});

module.exports = { server, handleApi, proxyToSarver, buildTree, STORE };
