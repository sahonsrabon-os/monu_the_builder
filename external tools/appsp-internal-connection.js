#!/usr/bin/env node
/**
 * appsp-internal-connection.js
 * ============================================================
 * Mission Barisal v3 — APPSP Internal Connection (External Tool)
 * ============================================================
 * A STANDALONE external tool that bridges our server to the
 * allindex.live.php / index.live.php PHP execution UI backend.
 *
 * Design decisions (per Sahon Srabon):
 *  - No extra complexity added to api.js — everything lives here.
 *  - NOT tied to any single cPanel account. Directory is configurable
 *    (cPanel path OR local machine path).
 *  - Mirrors the FRONTEND's core logic (allindex.live.php api() function).
 *  - Only agent responses are pulled from the PHP backend.
 *
 * Wire format (identical to allindex.live.php frontend):
 *   GET/POST  {PHP_UI_URL}?act=ai&path={PROJECT}&project_id={PID}
 *                       &ai_php_api={ACTION}&csrf_token={TOKEN}
 *   POST body: application/x-www-form-urlencoded
 *   Streaming: {PHP_UI_URL}?act=ai&path={PROJECT}&project_id={PID}
 *                       &ai_chat_stream=1  → SSE lines "data: {json}"
 *
 * Zero dependencies — pure Node.js (http/https).
 */

"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ─── CONFIG (env-driven, never hardcoded to one cPanel) ───
const CFG = {
  // PHP execution UI endpoint (index.live.php on the server).
  phpUrl: process.env.APPSP_PHP_URL || "",
  // Project directory on the target machine.
  //   cPanel: /home/USER/public_html/PROJECT
  //   local : /home/USER/projects/MYPROJECT
  projectPath: process.env.APPSP_PROJECT_PATH || "",
  // Project id (created via projects_create on first run).
  projectId: process.env.APPSP_PROJECT_ID || "",
  // CSRF token (obtained from the PHP backend session).
  csrfToken: process.env.APPSP_CSRF_TOKEN || "",
  // Optional auth header (X-API-Key / Bearer).
  apiKey: process.env.APPSP_API_KEY || "",
  // Timeout in ms.
  timeoutMs: parseInt(process.env.APPSP_TIMEOUT_MS || "120000", 10),
  // Where session/conversation state is persisted.
  stateFile: process.env.APPSP_STATE_FILE
    ? path.resolve(process.env.APPSP_STATE_FILE)
    : path.resolve(__dirname, "data", "appsp-state.json"),
};

// ─── Minimal state store (conversation_id persistence) ───
const state = { conversationId: "", sessions: [] };

function loadState() {
  try {
    if (fs.existsSync(CFG.stateFile)) {
      Object.assign(state, JSON.parse(fs.readFileSync(CFG.stateFile, "utf8")));
    }
  } catch (e) {
    /* ignore corrupt state */
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });
    fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2));
  } catch (e) {
    /* ignore */
  }
}

// ─── HTTP helper (zero-dep) ───
function request(method, urlStr, formBody, opts) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const headers = { Accept: "application/json" };
    if (formBody) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (CFG.apiKey) headers["X-API-Key"] = CFG.apiKey;
    const req = lib.request(
      u,
      { method, headers, timeout: CFG.timeoutMs },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: buf });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (formBody) req.write(formBody);
    req.end();
  });
}

function encode(obj) {
  return Object.entries(obj)
    .map(
      ([k, v]) =>
        encodeURIComponent(k) + "=" + encodeURIComponent(String(v))
    )
    .join("&");
}

function buildBaseUrl() {
  const u = new URL(CFG.phpUrl);
  u.searchParams.set("act", "ai");
  if (CFG.projectPath) u.searchParams.set("path", CFG.projectPath);
  if (CFG.projectId) u.searchParams.set("project_id", CFG.projectId);
  return u.toString();
}

// ─── Core: call an ai_php_api action ───
async function apiCall(action, data) {
  if (!CFG.phpUrl) throw new Error("APPSP_PHP_URL not configured");
  let url = buildBaseUrl();
  url += "&ai_php_api=" + encodeURIComponent(action);
  url += "&csrf_token=" + encodeURIComponent(CFG.csrfToken);
  const hasData = data && Object.keys(data).length > 0;
  const res = await request(hasData ? "POST" : "GET", url, hasData ? encode(data) : null);
  if (res.status !== 200) throw new Error("HTTP " + res.status + ": " + res.body.slice(0, 300));
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error("Non-JSON response: " + res.body.slice(0, 300));
  }
}

// ─── Streaming chat (ai_chat_stream=1, SSE) ───
async function streamChat(content, { conversationId, onEvent } = {}) {
  if (!CFG.phpUrl) throw new Error("APPSP_PHP_URL not configured");
  const url = buildBaseUrl() + "&ai_chat_stream=1";
  const body = encode({
    content,
    csrf_token: CFG.csrfToken,
    ...(conversationId ? { conversation_id: conversationId } : {}),
  });
  const res = await request("POST", url, body);
  // Parse SSE lines: "data: {json}"
  const lines = res.body.split("\n");
  let last = null;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    try {
      const d = JSON.parse(line.slice(5).trim());
      last = d;
      if (onEvent) onEvent(d);
    } catch (e) {
      /* skip malformed line */
    }
  }
  return last;
}

// ─── High-level: ensure project exists, then get/create session ───
async function ensureProject() {
  if (!CFG.projectId) {
    const list = await apiCall("projects_list", {});
    const existing = (list.projects || []).find(
      (p) => p.path === CFG.projectPath || p.project_id === CFG.projectId
    );
    if (existing) {
      CFG.projectId = existing.project_id;
      state.conversationId = state.conversationId || "";
    } else {
      const created = await apiCall("projects_create", {
        name: path.basename(CFG.projectPath || "project"),
        path: CFG.projectPath,
        type: "custom",
        insid: "",
      });
      CFG.projectId = created.project_id || created.id;
    }
    saveState();
  }
  if (!state.conversationId) {
    const ns = await apiCall("new_session", {});
    state.conversationId = ns.conversation_id || "";
    saveState();
  }
}

// ─── Tool entry: what api.js / MCP will call ───
async function runTool(args) {
  loadState();
  const action = args.action || "conversation";
  if (action === "ensure") {
    await ensureProject();
    return { ok: true, project_id: CFG.projectId, conversation_id: state.conversationId };
  }
  if (action === "chat" || action === "send") {
    await ensureProject();
    const events = [];
    const last = await streamChat(args.content || "", {
      conversationId: state.conversationId,
      onEvent: (e) => events.push(e),
    });
    if (last && last.conversation_id) state.conversationId = last.conversation_id;
    saveState();
    return { ok: true, conversation_id: state.conversationId, events, last };
  }
  // Generic pass-through of any ai_php_api action
  const data = { ...(args.data || {}) };
  if (action === "conversation" && !data.conversation_id) {
    data.conversation_id = state.conversationId;
  }
  const result = await apiCall(action, data);
  if (result.conversation_id) {
    state.conversationId = result.conversation_id;
    saveState();
  }
  return { ok: true, result };
}

// ─── CLI mode for manual testing ───
if (require.main === module) {
  const args = process.argv.slice(2);
  const action = args[0] || "ensure";
  const content = args[1] || "";
  runTool({ action, content })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((e) => {
      console.error("ERROR:", e.message);
      process.exit(1);
    });
}

module.exports = { runTool, apiCall, streamChat, ensureProject, CONFIG: CFG };
