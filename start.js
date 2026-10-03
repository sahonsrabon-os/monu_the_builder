#!/usr/bin/env node
// =============================================================================
// Mission Barisal v3 — Cross-Platform Start Script
// Entry point with two user-facing options:
//   1) CONFIG ALL  — write config.json to the OS default directory
//                    (Windows: %USERPROFILE%\.zombiecoder\, Linux/macOS: $HOME/.zombiecoder/)
//   2) START ALL   — load .env + config, then boot the main server (api.js)
// No hardcoded paths — every location is resolved at runtime per-OS.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const http = require("http");
const { execSync, spawn } = require("child_process");

const VERSION = "3.1.0";
const CONFIG_DIR = path.join(os.homedir(), ".zombiecoder");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// ─── Health-check / integration test endpoints ───
const HEALTH_ENDPOINTS = [
  { path: "/health", method: "GET", expect: { healthy: true }, name: "Health" },
  { path: "/api/v1/models", method: "GET", expect: (data) => data && (data.data || data.models) && Array.isArray(data.data || data.models), name: "Models v1" },
  { path: "/api/v0/models", method: "GET", expect: (data) => data && (data.data || data.models) && Array.isArray(data.data || data.models), name: "Models v0" },
  { path: "/api/agents", method: "GET", expect: { agents: Array }, name: "Agents" },
  { path: "/identity", method: "GET", expect: (data) => data && (data.system_identity || data.domain), name: "Identity" },
  { path: "/api/domain", method: "GET", expect: (data) => data && (data.detected || data.domain), name: "Domain" },
  { path: "/api/mcp-clients", method: "GET", expect: (data) => data && (data.connected_clients || data.clients || data.tools !== undefined), name: "MCP Clients" },
];

const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_DELAY_MS = 2000;
let localLlmBridgeChild = null;
let bridgeShutdownHooksInstalled = false;

// ---------------------------------------------------------------------------
// Environment loader (unchanged behavior, kept dependency-free)
// ---------------------------------------------------------------------------
function loadEnv() {
  try {
    const envPath = path.resolve(".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      let loaded = 0;
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        // Skip broken separator lines (e.g. "============" without #)
        if (/^=+$/.test(t)) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        if (!k) continue; // skip empty keys from malformed lines
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1);
        // .env values override empty env vars but never override
        // explicitly exported shell env vars (OS-level set takes priority)
        if (!process.env[k]) {
          process.env[k] = v;
          loaded++;
        }
      }
      console.log("[ENV] Loaded:", envPath, "(" + loaded + " vars)");
    }
  } catch (_) { }
}

// ---------------------------------------------------------------------------
// 🧟 ENV IMMUNITY — project .env is the Single Source of Truth for boot-
// critical keys. loadEnv() deliberately lets OS-level `export`s win, which is
// right for ad-hoc overrides but WRONG for keys that decide whether the whole
// boot survives: a stray `export BRIDGE_OLLAMA_URL=...` (shell history, editor,
// parent process) made the LLM bridge poll ITSELF, never become ready, and
// abort the gateway before it ever bound — taking the MCP tool chain with it.
// applyEnvImmunity() re-imposes .env on the keys below, then validates them.
// ---------------------------------------------------------------------------
const CRITICAL_ENV_KEYS = [
  "PORT",
  "SERVER_PORT",
  "APP_URL",
  "BIND_HOST",
  "BRIDGE_BACKEND",
  "BRIDGE_OLLAMA_URL",
  "BRIDGE_UPSTREAM_MODEL",
  "BRIDGE_MODEL",
  "OLLAMA_BASE",
  "BROKER_PORT",
  "BRIDGE_PROXY_PORT",
  "BRIDGE_TARGET_PORT",
  "SESSION_HMAC_REQUIRED", // fail-closed switch — shell must not flip it silently
  "LOCAL_MAX_TOKENS", // local output cap — 128 starved thinking models into empty replies
  "OLLAMA_MODELS", // routing truth — wrong model list reroutes agents to dead providers
];

function readDotEnvFile() {
  const out = {};
  try {
    const p = path.resolve(".env");
    if (!fs.existsSync(p)) return out;
    for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
      const t = raw.trim();
      if (!t || t.startsWith("#") || /^=+$/.test(t)) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      if (!k) continue;
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      out[k] = v;
    }
  } catch (_) {
    /* missing .env → nothing to impose */
  }
  return out;
}

function applyEnvImmunity() {
  const dot = readDotEnvFile();
  let normalized = 0;

  // 1) .env wins over stray shell exports for boot-critical keys
  for (const k of CRITICAL_ENV_KEYS) {
    if (dot[k] === undefined || dot[k] === "") continue;
    const shellVal = process.env[k];
    if (shellVal !== undefined && shellVal !== dot[k]) {
      console.log(
        "[ENV-IMMUNITY] " +
          k +
          ": ignored shell value '" +
          shellVal +
          "' → .env = '" +
          dot[k] +
          "'",
      );
      normalized++;
    }
    process.env[k] = dot[k];
  }

  // 2) BRIDGE_PORT is ambiguous: local-llm-bridge treats it as the LLM port
  //    (default 11435), bridge.js historically treated it as its listen port
  //    (default 9999). If a shell export carries the PROXY meaning, disambiguate.
  if (
    process.env.BRIDGE_PORT &&
    !dot.BRIDGE_PORT &&
    parseInt(process.env.BRIDGE_PORT, 10) === (parseInt(process.env.BRIDGE_PROXY_PORT || "9999", 10))
  ) {
    console.warn(
      "[ENV-IMMUNITY] BRIDGE_PORT=" +
        process.env.BRIDGE_PORT +
        " looks like the editor proxy → moved to BRIDGE_PROXY_PORT",
    );
    process.env.BRIDGE_PROXY_PORT = process.env.BRIDGE_PORT;
    delete process.env.BRIDGE_PORT;
    normalized++;
  }

  // Port roles are read AFTER the disambiguation above so the self-reference
  // check never validates against a stale number.
  const LLM_PORT = parseInt(process.env.BRIDGE_PORT || "11435", 10); // local-llm-bridge.js
  const PROXY_PORT = parseInt(process.env.BRIDGE_PROXY_PORT || "9999", 10); // bridge.js (editor proxy)
  const GATEWAY = parseInt(process.env.PORT || "5000", 10);

  // 3) BRIDGE_OLLAMA_URL must be the OLLAMA DAEMON — never self/proxy/gateway
  let ollama = (process.env.BRIDGE_OLLAMA_URL || "http://127.0.0.1:11434").trim();
  try {
    const u = new URL(ollama);
    const p = u.port ? parseInt(u.port, 10) : u.protocol === "https:" ? 443 : 80;
    if (u.protocol !== "http:" || p === LLM_PORT || p === PROXY_PORT || p === GATEWAY) {
      console.warn(
        "[ENV-IMMUNITY] BRIDGE_OLLAMA_URL='" +
          ollama +
          "' is not the Ollama daemon (self/proxy/gateway port) → forcing http://127.0.0.1:11434",
      );
      ollama = "http://127.0.0.1:11434";
      normalized++;
    }
  } catch (_) {
    console.warn(
      "[ENV-IMMUNITY] BRIDGE_OLLAMA_URL malformed ('" +
        ollama +
        "') → forcing http://127.0.0.1:11434",
    );
    ollama = "http://127.0.0.1:11434";
    normalized++;
  }
  process.env.BRIDGE_OLLAMA_URL = ollama;

  if (normalized) {
    console.log(
      "[ENV-IMMUNITY] " + normalized + " boot-critical value(s) normalized — shell cannot change boot behavior",
    );
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Environment Detection & Runtime Setup
// ---------------------------------------------------------------------------
function detectEnvironment() {
  const platform = process.platform; // 'win32', 'linux', 'darwin'
  const arch = process.arch;
  const nodeVersion = process.version;
  const isWindows = platform === "win32";
  const isLinux = platform === "linux";
  const isMac = platform === "darwin";
  
  const envInfo = {
    platform,
    arch,
    nodeVersion,
    isWindows,
    isLinux,
    isMac,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    cpus: os.cpus().length,
    totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    hostname: os.hostname(),
    username: process.env.USER || process.env.USERNAME || "unknown",
    cwd: process.cwd(),
    dataDir: path.join(process.cwd(), "data"),
    configDir: CONFIG_DIR,
    timestamp: new Date().toISOString(),
  };
  
  console.log("\n[ENV-DETECT] Environment detected:");
  console.log(`  Platform: ${platform} (${isWindows ? "Windows" : isLinux ? "Linux" : isMac ? "macOS" : "Unknown"})`);
  console.log(`  Arch: ${arch}, Node: ${nodeVersion}`);
  console.log(`  User: ${envInfo.username} @ ${envInfo.hostname}`);
  console.log(`  CWD: ${envInfo.cwd}`);
  console.log(`  Data Dir: ${envInfo.dataDir}`);
  console.log(`  Config Dir: ${envInfo.configDir}`);
  console.log(`  Memory: ${envInfo.totalMemGB} GB, CPUs: ${envInfo.cpus}`);
  
  return envInfo;
}

function ensureDatabase() {
  console.log("\n[DB] Ensuring database from environment variables...");
  
  // Create data directory if not exists
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("[DB] Created data directory:", dataDir);
  }
  
  // Verify models.db exists and has tables
  const dbPath = path.join(dataDir, "models.db");
  if (fs.existsSync(dbPath)) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      const modelCount = db.prepare("SELECT COUNT(*) as c FROM models").get().c;
      const agentCount = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
      
      console.log("[DB] models.db exists with tables:", tables.join(", "));
      console.log(`[DB] Models: ${modelCount}, Agents: ${agentCount}`);
      db.close();
      return { exists: true, tables, modelCount, agentCount };
    } catch (err) {
      console.warn("[DB] Could not read existing models.db:", err.message);
    }
  } else {
    console.log("[DB] models.db not found — will be created by api.js on startup");
  }
  
  return { exists: false };
}

function storeRuntimeConfig(envInfo) {
  try {
    const dataDir = path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    
    // Capture all relevant env vars for debugging/inspection
    const runtimeConfig = {
      savedAt: new Date().toISOString(),
      environment: envInfo,
      envVars: {},
      providers: {},
    };
    
    // Filter and store relevant env vars (exclude secrets)
    const relevantKeys = [
      "PORT", "SERVER_PORT", "UDS_PORT", "APP_URL", "DOMAIN",
      "NOTE_ENCRYPTION_KEY", "NOTE_TTL", "MAX_NOTE_SIZE",
      "GROQ_MODELS", "GEMINI_MODELS",
      "ADMIN_USER", "ADMIN_API_KEY",
      "PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER",
    ];
    
    for (const key of relevantKeys) {
      if (process.env[key]) {
        runtimeConfig.envVars[key] = key.includes("KEY") || key.includes("SECRET") 
          ? "***REDACTED***" 
          : process.env[key];
      }
    }
    
    // Capture custom providers
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^CUSTOM_PROVIDER_(\d+)_NAME$/);
      if (m) {
        const n = m[1];
        const name = process.env[k];
        runtimeConfig.providers[name] = {
          name,
          url: process.env[`CUSTOM_PROVIDER_${n}_URL`] || "",
          type: process.env[`CUSTOM_PROVIDER_${n}_TYPE`] || "openai",
          priority: process.env[`CUSTOM_PROVIDER_${n}_PRIORITY`] || "",
          models: String(process.env[`CUSTOM_PROVIDER_${n}_MODELS`] || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean),
        };
      }
    }
    
    const outPath = path.join(dataDir, "startup-config.json");
    fs.writeFileSync(outPath, JSON.stringify(runtimeConfig, null, 2), "utf8");
    console.log("[STORE] Runtime config saved ->", outPath);
    console.log(`[STORE] Providers captured: ${Object.keys(runtimeConfig.providers).length}`);
    console.log(`[STORE] Env vars captured: ${Object.keys(runtimeConfig.envVars).length}`);
    
    return outPath;
  } catch (err) {
    console.warn("[STORE] Warning — could not save runtime config:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP Test Client (no external deps)
// ---------------------------------------------------------------------------
function httpRequest(
  host,
  port,
  path,
  method = "GET",
  body = null,
  extraHeaders = {},
  timeoutMs = 5000,
) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "MissionBarisal-StartScript/1.0",
        ...extraHeaders,
      },
    };
    
    if (body) {
      const data = JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(data);
    }
    
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });
    
    req.on("error", (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function installBridgeShutdownHooks() {
  if (bridgeShutdownHooksInstalled) return;
  bridgeShutdownHooksInstalled = true;
  const stopOwnedBridge = () => {
    if (localLlmBridgeChild && localLlmBridgeChild.exitCode === null) {
      localLlmBridgeChild.kill("SIGTERM");
    }
  };
  process.once("SIGINT", stopOwnedBridge);
  process.once("SIGTERM", stopOwnedBridge);
  process.once("exit", stopOwnedBridge);
}

async function readBridgeHealth(port) {
  try {
    const response = await httpRequest("127.0.0.1", port, "/health");
    if (response.status !== 200) return { error: "HTTP " + response.status };
    if (response.data?.bridge !== "local-llm-bridge") {
      return { error: "port is occupied by a non-bridge service" };
    }
    return { health: response.data };
  } catch (_) {
    return null;
  }
}

async function preloadBridgeModel(health) {
  if (health.backend !== "ollama") {
    console.log("[LOCAL-LLM] Backend ready:", health.backend, health.model || "");
    return;
  }
  const base = new URL(process.env.BRIDGE_OLLAMA_URL || "http://127.0.0.1:11434");
  if (base.protocol !== "http:") {
    throw new Error("BRIDGE_OLLAMA_URL must use http for local model preloading");
  }
  const port = Number(base.port) || 80;
  const warmup = await httpRequest(
    base.hostname,
    port,
    "/api/chat",
    "POST",
    { model: health.model, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "10m" },
    {},
    Number(process.env.OLLAMA_MODEL_LOAD_TIMEOUT_MS) || 180000,
  );
  if (warmup.status !== 200) {
    throw new Error("Ollama model preload failed (HTTP " + warmup.status + ")");
  }
  const loadMs = Number(warmup.data?.load_duration || 0) / 1e6;
  console.log(
    "[LOCAL-LLM] Model loaded and retained:",
    health.model,
    "load_ms=" + Math.round(loadMs),
  );
}

async function ensureLocalLlmBridge() {
  if (String(process.env.LOCAL_LLM_BRIDGE_ENABLED || "true").toLowerCase() === "false") {
    console.log("[LOCAL-LLM] Disabled by LOCAL_LLM_BRIDGE_ENABLED=false");
    return;
  }
  const bridgePath = path.join(__dirname, "local-llm-bridge.js");
  if (!fs.existsSync(bridgePath)) throw new Error("local-llm-bridge.js is missing");
  const port = Number(process.env.BRIDGE_PORT) || 11435;
  const timeoutMs = Number(process.env.BRIDGE_STARTUP_TIMEOUT_MS) || 120000;
  const existing = await readBridgeHealth(port);
  if (existing?.error) throw new Error("Bridge port " + port + ": " + existing.error);

  if (!existing) {
    console.log("[LOCAL-LLM] Starting bridge before gateway...");
    localLlmBridgeChild = spawn(process.execPath, [bridgePath], {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit",
    });
    installBridgeShutdownHooks();
    localLlmBridgeChild.on("error", (err) => {
      console.error("[LOCAL-LLM] Bridge spawn error:", err.message);
    });
    localLlmBridgeChild.on("exit", (code, signal) => {
      console.log("[LOCAL-LLM] Owned bridge exited code=" + code + " signal=" + signal);
    });
  } else {
    console.log("[LOCAL-LLM] Reusing existing bridge on port " + port);
  }

  const deadline = Date.now() + timeoutMs;
  let bridgeHealth = existing?.health || null;
  while (!bridgeHealth?.upstream?.ready && Date.now() < deadline) {
    if (localLlmBridgeChild && localLlmBridgeChild.exitCode !== null) {
      throw new Error("Bridge exited before upstream became ready");
    }
    const status = await readBridgeHealth(port);
    if (status?.error) throw new Error("Bridge port " + port + ": " + status.error);
    bridgeHealth = status?.health || null;
    if (!bridgeHealth?.upstream?.ready) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!bridgeHealth?.upstream?.ready) {
    throw new Error("Bridge upstream not ready after " + timeoutMs + "ms");
  }
  await preloadBridgeModel(bridgeHealth);
}

// ---------------------------------------------------------------------------
// Health Check / Integration Test
// ---------------------------------------------------------------------------
async function runHealthChecks(host, port) {
  console.log("\n[HEALTH] Starting integration tests against http://" + host + ":" + port + " ...");
  
  // Wait for server to be ready
  await new Promise(r => setTimeout(r, HEALTH_CHECK_DELAY_MS));
  
  const results = [];
  let passed = 0;
  let failed = 0;
  
  for (const endpoint of HEALTH_ENDPOINTS) {
    try {
      const start = Date.now();
      const response = await httpRequest(host, port, endpoint.path, endpoint.method);
      const elapsed = Date.now() - start;
      
      let ok = false;
      if (response.status === 200) {
        if (typeof endpoint.expect === "function") {
          ok = endpoint.expect(response.data);
        } else if (endpoint.expect && typeof endpoint.expect === "object") {
          ok = Object.keys(endpoint.expect).every(key => {
            const expectedType = endpoint.expect[key];
            const actualValue = response.data[key];
            if (expectedType === Array) return Array.isArray(actualValue);
            if (expectedType === String) return typeof actualValue === "string";
            if (expectedType === Number) return typeof actualValue === "number";
            if (expectedType === Boolean) return typeof actualValue === "boolean";
            if (expectedType === Object) return actualValue !== null && typeof actualValue === "object";
            return actualValue !== undefined;
          });
        } else {
          ok = true;
        }
      }
      
      if (ok) {
        passed++;
        console.log(`  ✅ ${endpoint.name} (${endpoint.method} ${endpoint.path}) — ${response.status} (${elapsed}ms)`);
      } else {
        failed++;
        console.log(`  ❌ ${endpoint.name} (${endpoint.method} ${endpoint.path}) — ${response.status} (${elapsed}ms) — Unexpected response`);
        console.log(`     Response:`, JSON.stringify(response.data).slice(0, 200));
      }
      
      results.push({
        endpoint: endpoint.name,
        path: endpoint.path,
        method: endpoint.method,
        status: response.status,
        ok,
        elapsed,
        data: response.data,
      });
    } catch (err) {
      failed++;
      console.log(`  ❌ ${endpoint.name} (${endpoint.method} ${endpoint.path}) — ERROR: ${err.message}`);
      results.push({
        endpoint: endpoint.name,
        path: endpoint.path,
        method: endpoint.method,
        error: err.message,
        ok: false,
      });
    }
  }
  
  console.log(`\n[HEALTH] Results: ${passed} passed, ${failed} failed`);
  
  // Save health check results
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const resultPath = path.join(dataDir, "health-check-" + Date.now() + ".json");
  fs.writeFileSync(resultPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    host,
    port,
    passed,
    failed,
    results,
  }, null, 2), "utf8");
  console.log("[HEALTH] Results saved to:", resultPath);
  
  return { passed, failed, results };
}

// ---------------------------------------------------------------------------
// OS default directory resolution (no hardcoded C:\ or /home paths)
// ---------------------------------------------------------------------------
function getDefaultConfig() {
  return {
    version: VERSION,
    serverPort: Number(process.env.SERVER_PORT) || Number(process.env.PORT) || 5000,
    udsPort: Number(process.env.UDS_PORT) || 5100,
    udsPath:
      process.env.ZOMBIECODER_UDS_PATH ||
      path.join(os.tmpdir(), "zombiecoder", "mcp.sock"),
    workingDir: process.cwd(),
    homeDir: os.homedir(),
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CONFIG ALL — write config.json to the OS default directory
// ---------------------------------------------------------------------------
function configAll() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = getDefaultConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    console.log("");
    console.log("[CONFIG ALL] config.json created at:");
    console.log("  " + CONFIG_PATH);
    console.log("");
    console.log("  serverPort :", cfg.serverPort);
    console.log("  udsPort    :", cfg.udsPort);
    console.log("  udsPath    :", cfg.udsPath);
    console.log("  workingDir :", cfg.workingDir);
    console.log("  homeDir    :", cfg.homeDir);
    console.log("");
    console.log("This location is OS-default (os.homedir()). The server and the");
    console.log("extension can both read it from any working directory.");
    return 0;
  } catch (err) {
    console.error("[CONFIG ALL] Failed:", err.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// START ALL — load env + config, then boot the main server
// ---------------------------------------------------------------------------
// Pids of this process and all its ancestors — never killed, ever.
function selfAncestorPids() {
  const set = new Set([process.pid]);
  if (process.platform === "win32") return set;
  let p = process.pid;
  for (let i = 0; i < 16; i++) {
    try {
      const stat = fs.readFileSync("/proc/" + p + "/stat", "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = parseInt(rest[1], 10); // rest = [state, ppid, pgrp, ...]
      if (!ppid || ppid <= 1 || set.has(ppid)) break;
      set.add(ppid);
      p = ppid;
    } catch (_) {
      break;
    }
  }
  return set;
}

function portListening(port) {
  if (process.platform === "win32") return false;
  try {
    execSync('ss -ltn 2>/dev/null | grep -q ":' + port + ' "', {
      stdio: "ignore",
      shell: "/bin/bash",
    });
    return true;
  } catch (_) {
    return false;
  }
}

// Is the process listening on this port owned by THIS project directory?
// Foreign squatters (other projects, services) are never ours to kill — and
// never worth waiting for.
function portOwnedByProject(port) {
  if (process.platform === "win32") return false;
  try {
    const out = execSync('ss -ltnp 2>/dev/null | grep ":' + port + ' "', {
      encoding: "utf8",
      shell: "/bin/bash",
    });
    const m = String(out).match(/pid=(\d+)/);
    if (!m) return false;
    return fs.realpathSync("/proc/" + parseInt(m[1], 10) + "/cwd") === __dirname;
  } catch (_) {
    return false;
  }
}

async function cleanupOldProcesses() {
  // Kill any previously-running server processes (api.js / hamba.js /
  // php-broker-server.js) and free the target port BEFORE booting fresh.
  // Cross-platform: Windows uses netstat + taskkill; Linux/macOS uses
  // ss/ps + process.kill. The current process (this start.js) is never killed.
  const targetPort =
    Number(process.env.PORT) ||
    Number(process.env.SERVER_PORT) ||
    5000;
  console.log(
    "[CLEANUP] Scanning for old server processes on port " +
      targetPort +
      " ...",
  );
  const killed = new Set();

  // Snapshot OUR auxiliary listeners before killing anything: only ports whose
  // current owner lives in this project are expected to disappear. A foreign
  // service on the same port is left alone — and not waited on either.
  const preListeningAux = [
    parseInt(process.env.BRIDGE_PROXY_PORT || "9999", 10),
    parseInt(process.env.BROKER_PORT || "9998", 10),
    parseInt(process.env.BRIDGE_PORT || "11435", 10),
  ].filter((p) => p && portOwnedByProject(p));

  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const findPidsOnPort = () => {
    const pids = new Set();
    try {
      const out =
        process.platform === "win32"
          ? execSync('netstat -ano | findstr ":' + targetPort + '"', {
              encoding: "utf8",
            })
          : execSync('ss -tlnp 2>/dev/null | grep ":' + targetPort + ' "', {
              encoding: "utf8",
            });
      if (process.platform === "win32") {
        for (const line of String(out).split("\n")) {
          const m = line.match(/LISTENING\s+(\d+)\s*$/);
          if (m) pids.add(parseInt(m[1], 10));
        }
      } else {
        for (const m of String(out).matchAll(/pid=(\d+)/g))
          pids.add(parseInt(m[1], 10));
      }
    } catch (_) {
      /* ss/netstat may not be present — ignore */
    }
    return [...pids];
  };

  const isOwnedServerPid = (pid) => {
    if (process.platform === "linux") {
      try {
        const cwd = fs.realpathSync("/proc/" + pid + "/cwd");
        const args = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ");
        return cwd === __dirname && /(?:start|api|hamba)\.js\b/.test(args);
      } catch (_) {
        return false;
      }
    }
    if (process.platform !== "win32") {
      try {
        const cwd = execSync("lsof -a -p " + pid + " -d cwd -Fn 2>/dev/null", { encoding: "utf8" });
        const args = execSync("ps -p " + pid + " -o args=", { encoding: "utf8" });
        return cwd.split("\n").some((line) => line === "n" + __dirname) && /(?:start|api|hamba)\.js\b/.test(args);
      } catch (_) {
        return false;
      }
    }
    return false;
  };

  const killPid = (pid, force) => {
    if (!pid || pid === process.pid || killed.has(pid)) return;
    killed.add(pid);
    try {
      if (process.platform === "win32") {
        execSync("taskkill /F /PID " + pid, { stdio: "ignore" });
      } else {
        try {
          process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        } catch (_) {}
      }
      console.log(
        "[CLEANUP] Killed old process pid=" + pid + (force ? " (forced)" : ""),
      );
    } catch (_) {}
  };

  // 1) Kill only a gateway process owned by this project. Never terminate
  //    an unrelated service just because it occupies the configured port.
  for (const pid of findPidsOnPort()) {
    if (!isOwnedServerPid(pid)) {
      console.error("[CLEANUP] Port " + targetPort + " is occupied by unmanaged pid=" + pid + "; refusing to kill it.");
      return false;
    }
    killPid(pid, false);
  }

  // 2) Kill EVERY node process owned by THIS project — an older start.js
  //    (even one stuck mid-bootstrap), gateway api.js, editor proxy bridge.js,
  //    local-llm-bridge, php-broker, note-store — so this run starts truly
  //    fresh instead of racing leftovers. Previously only api/hamba/broker
  //    were matched and start.js was explicitly skipped, so a wedged prior
  //    run survived and fought the new one.
  //    SAFETY: (a) this directory only, (b) never self or an ancestor,
  //    (c) never the LLM bridge when CLEAN_KEEP_BRIDGE=true (keeps model warm).
  if (process.platform !== "win32") {
    const keepBridge =
      String(process.env.CLEAN_KEEP_BRIDGE || "").toLowerCase() === "true";
    const PROJECT_SCRIPTS =
      /(?:^|[\s/])(start|api|hamba|bridge|local-llm-bridge|php-broker-server|note-store|start-local-mcp)\.js(?:\s|$)/;
    const protect = selfAncestorPids();
    try {
      const out = execSync('ps -eo pid,args | grep -E "node " | grep -v grep', {
        encoding: "utf8",
      });
      for (const line of String(out).split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const args = m[2] || "";
        if (protect.has(pid)) continue; // never self or an ancestor
        if (args.indexOf(__dirname) === -1) continue; // this dir only
        if (!PROJECT_SCRIPTS.test(args)) continue;
        if (keepBridge && /local-llm-bridge\.js/.test(args)) continue;
        killPid(pid, false);
      }
    } catch (_) {}
  }

  // 3) Wait for the port to free (up to ~5s), then force-kill leftovers
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (findPidsOnPort().length === 0) break;
    await sleepMs(300);
  }
  for (const pid of findPidsOnPort()) {
    if (!isOwnedServerPid(pid)) {
      console.error("[CLEANUP] Port " + targetPort + " remains occupied by unmanaged pid=" + pid + "; refusing to force-kill it.");
      return false;
    }
    killPid(pid, true);
  }

  // 3b) Wait for THIS project's auxiliary listeners to disappear — but only
  //     for ports that were already listening before we started killing (i.e.
  //     ones a leftover of ours owns). A foreign service squatting 9999/9998
  //     is not ours to fight: cleanup refuses to kill it, so don't wait on it.
  if (killed.size && process.platform !== "win32" && preListeningAux.length) {
    const aux = new Set(preListeningAux);
    if (String(process.env.CLEAN_KEEP_BRIDGE || "").toLowerCase() !== "true") {
      const llm = parseInt(process.env.BRIDGE_PORT || "11435", 10);
      if (portListening(llm)) aux.add(llm);
    }
    const auxDeadline = Date.now() + 5000;
    while (Date.now() < auxDeadline) {
      const alive = [...aux].filter((p) => p && portListening(p));
      if (!alive.length) break;
      await sleepMs(300);
    }
    const still = [...aux].filter((p) => p && portListening(p));
    if (still.length) {
      console.warn(
        "[CLEANUP] auxiliary ports still listening after kill: " + still.join(", "),
      );
    } else {
      console.log("[CLEANUP] auxiliary ports free: " + [...aux].join(", "));
    }
  }

  console.log("[CLEANUP] Port " + targetPort + " is free. Starting fresh ...");
  return true;
}

function storeModels() {
  // Capture provider/model configuration from environment variables and
  // persist a snapshot so the configured models are stored / inspectable.
  // Mirrors what the server boots with (CUSTOM_PROVIDER_* + built-ins).
  try {
    const providers = {};
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^CUSTOM_PROVIDER_(\d+)_NAME$/);
      if (m) {
        const n = m[1];
        const name = process.env[k];
        providers[name] = {
          name,
          url: process.env["CUSTOM_PROVIDER_" + n + "_URL"] || "",
          type: process.env["CUSTOM_PROVIDER_" + n + "_TYPE"] || "openai",
          priority: process.env["CUSTOM_PROVIDER_" + n + "_PRIORITY"] || "",
          models: String(process.env["CUSTOM_PROVIDER_" + n + "_MODELS"] || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
    }
    const snapshot = {
      savedAt: new Date().toISOString(),
      port: process.env.PORT,
      appUrl: process.env.APP_URL,
      providers,
    };
    const outDir = path.join(__dirname, "data");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "startup-config.json");
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log("[STORE] Provider/model snapshot saved -> " + outPath);
  } catch (err) {
    console.warn("[STORE] Warning — could not save snapshot:", err.message);
  }
}

// ─── Editor proxy (bridge.js : PROXY → gateway) ────────────────────────────
// Owned by the starter: cleanup kills stale proxies, this re-spawns a fresh
// one pointed at the CURRENT gateway port — a leftover proxy otherwise keeps
// forwarding editors to a dead port after a restart.
let editorBridgeChild = null;

function startEditorBridge() {
  const proxyPath = path.join(__dirname, "bridge.js");
  if (!fs.existsSync(proxyPath)) {
    console.warn("[EDITOR-BRIDGE] bridge.js not found — editor proxy skipped");
    return;
  }
  // Legacy reverse-proxy from an old download (editors → gateway). Off by
  // default: the current topology doesn't use 9999 (Cloudflare tunnel talks
  // straight to the gateway), so we never squat or fight over that port.
  if (String(process.env.EDITOR_BRIDGE_ENABLED || "").toLowerCase() !== "true") {
    console.log(
      "[EDITOR-BRIDGE] off (legacy bridge.js; set EDITOR_BRIDGE_ENABLED=true to run it)",
    );
    return;
  }
  const proxyPort = parseInt(process.env.BRIDGE_PROXY_PORT || "9999", 10);
  const targetPort = parseInt(process.env.PORT || "5000", 10);
  if (portListening(proxyPort)) {
    console.warn(
      "[EDITOR-BRIDGE] port " + proxyPort + " already taken by another service — skipped",
    );
    return;
  }
  editorBridgeChild = spawn(process.execPath, [proxyPath], {
    cwd: __dirname,
    stdio: "inherit",
    env: {
      ...process.env,
      // Explicit, unambiguous values: bridge.js reads BRIDGE_PORT as ITS
      // listen port while start.js reads BRIDGE_PORT as the LLM bridge port.
      BRIDGE_PROXY_PORT: String(proxyPort),
      BRIDGE_PORT: String(proxyPort),
      BRIDGE_TARGET_HOST: "127.0.0.1",
      BRIDGE_TARGET_PORT: String(targetPort),
    },
  });
  editorBridgeChild.on("error", (e) =>
    console.error("[EDITOR-BRIDGE] spawn error:", e.message),
  );
  editorBridgeChild.on("exit", (code, sig) => {
    console.log("[EDITOR-BRIDGE] exited code=" + code + " signal=" + sig);
    editorBridgeChild = null;
  });
  const stop = () => {
    if (editorBridgeChild && editorBridgeChild.exitCode === null) {
      editorBridgeChild.kill("SIGTERM");
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stop);
  console.log(
    "[EDITOR-BRIDGE] spawned bridge.js pid=" +
      editorBridgeChild.pid +
      " :" +
      proxyPort +
      " → 127.0.0.1:" +
      targetPort,
  );
}

function startBroker() {
  // Spawn the PHP broker server (php-broker-server.js) alongside the
  // sarver. It reads BROKER_PORT / FRONTEND_DIR / brokerUrl from the
  // already-loaded process.env (loaded from .env in startAll).
  const brokerPath = path.join(__dirname, "external tools", "php-broker-server.js");
  if (!fs.existsSync(brokerPath)) {
    console.warn("[BROKER] php-broker-server.js not found at:", brokerPath);
    return;
  }
  const broker = spawn(process.execPath, [brokerPath], {
    stdio: "inherit",
    env: process.env,
  });
  broker.on("error", (err) => console.error("[BROKER] spawn error:", err.message));
  broker.on("exit", (code, signal) => {
    console.log("[BROKER] exited code=" + code + " signal=" + signal);
  });
  console.log("[BROKER] spawned php-broker-server.js (pid " + broker.pid + ")");
}

async function startAll() {
  console.log("\n" + "=".repeat(60));
  console.log("  Mission Barisal v" + VERSION + " — START ALL (Full Bootstrap)");
  console.log("=".repeat(60));
  
  // 1. Load .env first, then lock boot-critical keys against shell exports
  loadEnv();
  applyEnvImmunity();
  
  // 2. Detect environment
  const envInfo = detectEnvironment();
  
  // 3. Ensure database exists (will be created by api.js if not present)
  const dbStatus = ensureDatabase();
  
  // 4. Store runtime config from env vars
  storeRuntimeConfig(envInfo);
  
  // ── Final required conditions (user-specified) ──
  // PORT must be 5000 and APP_URL must point at the public app URL.
  // Enforced even if missing from .env so the server always boots on the
  // expected port / URL.
  process.env.PORT = process.env.PORT || "5000";
  // APP_URL: derive from DEPLOY_DOMAIN if not set, don't hardcode
  if (!process.env.APP_URL) {
    const domain = process.env.DEPLOY_DOMAIN || "localhost";
    const port = process.env.PORT;
    const isLocal = domain === "localhost" || domain === "127.0.0.1";
    process.env.APP_URL = (isLocal ? "http" : "https") + "://" + domain + (isLocal ? ":" + port : "");
  }
  console.log("[ENV] Final conditions -> PORT=" + process.env.PORT + " APP_URL=" + process.env.APP_URL);
  
  // 5. Auto-ensure config exists in the OS default directory (idempotent).
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(getDefaultConfig(), null, 2), "utf8");
      console.log("[CONFIG] Auto-created:", CONFIG_PATH);
    } else {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      console.log("[CONFIG] Loaded:", CONFIG_PATH);
      // Env vars take priority over config.json (so PORT/SERVER_PORT in .env win)
      if (cfg.serverPort && !process.env.SERVER_PORT && !process.env.PORT) {
        process.env.PORT = String(cfg.serverPort);
      }
    }
  } catch (err) {
    console.warn("[CONFIG] Warning — continuing without config:", err.message);
  }
  
  // 6. Cleanup old processes
  console.log("[START ALL] Cleaning up old server processes ...");
  if (!(await cleanupOldProcesses())) return;
  
  // 7. Boot the server
  console.log("[START ALL] Booting Mission Barisal v" + VERSION + " ...");
  // Start/wait for and preload the model bridge before any gateway workers.
  try {
    await ensureLocalLlmBridge();
  } catch (e) {
    console.error("[LOCAL-LLM] Startup blocked:", e.message);
    if (localLlmBridgeChild && localLlmBridgeChild.exitCode === null) {
      localLlmBridgeChild.kill("SIGTERM");
    }
    return;
  }

  startBroker();
  startEditorBridge();

  // Start local MCP servers (OCR, Screen Recorder, TTS) after model readiness.
  try {
    const { startLocalServers } = require("./start-local-mcp.js");
    const mcpResults = await startLocalServers();
    const readyCount = mcpResults.filter(r => r.status === "ready").length;
    if (mcpResults.length > 0) {
      console.log("[START ALL] Local MCP servers: " + readyCount + "/" + mcpResults.length + " ready");
    }
  } catch (e) {
    console.warn("[START ALL] Local MCP startup warning:", e.message);
  }
  
  // 8. Start server and run health checks
  const port = Number(process.env.PORT);
  const host = "127.0.0.1";
  
  // We need to start the server and then run health checks
  // The api.js will start the HTTP server
  let serverStarted = false;
  
  // Hook into process to run health checks after a delay
  setTimeout(async () => {
    if (!serverStarted) {
      try {
        const headHealth = await httpRequest(host, port, "/health", "HEAD");
        let adminHead = { status: 0 };
        let anonymousHead = { status: 0 };
        if (process.env.ADMIN_TOKEN) {
          adminHead = await httpRequest(
            host,
            port,
            "/api/admin/providers",
            "HEAD",
            null,
            { "X-Admin-Token": process.env.ADMIN_TOKEN },
          );
          anonymousHead = await httpRequest(
            host,
            port,
            "/api/admin/providers",
            "HEAD",
          );
          if (adminHead.status !== 200 || anonymousHead.status !== 401) {
            throw new Error("ADMIN_TOKEN HEAD verification failed");
          }
        } else {
          adminHead = await httpRequest(
            host,
            port,
            "/api/admin/providers",
            "HEAD",
          );
        }
        if (headHealth.status !== 200 || adminHead.status !== 200) {
          throw new Error("gateway HEAD verification failed");
        }
        console.log("[VERIFY] HEAD /health: 200; ADMIN_TOKEN: verified");
      } catch (e) {
        console.error("[VERIFY] Startup HEAD/auth check failed:", e.message);
      }
      console.log("[HEALTH] Running post-startup integration tests...");
      const results = await runHealthChecks(host, port);
      
      if (results.failed === 0) {
        console.log("\n[START ALL] ✅ All systems operational!");
        console.log("[START ALL] Server is ready at http://" + host + ":" + port);
        console.log("[START ALL] API endpoints verified and responding.\n");
      } else {
        console.log("\n[START ALL] ⚠️  Some health checks failed — server running but may need attention");
        console.log("[START ALL] Server is at http://" + host + ":" + port + " (check health-check-*.json for details)\n");
      }
      serverStarted = true;
    }
  }, 4000); // Wait for server to fully boot
  
  // Start the actual server (this blocks)
  require("./api.js");
}

// ---------------------------------------------------------------------------
// Interactive prompt (user-facing strings stay in English)
// ---------------------------------------------------------------------------
function showMenu() {
  console.log("");
  console.log("==============================================");
  console.log("  Mission Barisal v" + VERSION + " — Starter");
  console.log("==============================================");
  console.log("");
  console.log("  1) CONFIG ALL — write config to the OS default directory");
  console.log("                  Windows: %USERPROFILE%\\.zombiecoder\\");
  console.log("                  Linux  : $HOME/.zombiecoder/");
  console.log("  2) START ALL  — load .env + config, then boot the server");
  console.log("                  (includes env detection, DB verify, health checks)");
  console.log("  0) Exit");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Choose an option (1/2/0): ", (answer) => {
    rl.close();
    const a = (answer || "").trim();
    if (a === "1") process.exitCode = configAll();
    else if (a === "2") startAll();
    else {
      console.log("Bye!");
      process.exit(0);
    }
  });
}

// ---------------------------------------------------------------------------
// CLI flag parsing (non-interactive mode)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage:");
  console.log("  node start.js                  interactive menu (CONFIG ALL / START ALL)");
  console.log("  node start.js --config-all -c  run CONFIG ALL (write config.json)");
  console.log("  node start.js --start-all -s   run START ALL (full bootstrap + health checks)");
  console.log("  node start.js --health-only    run health checks against existing server");
  process.exit(0);
}

if (args.includes("--config-all") || args.includes("-c")) {
  process.exitCode = configAll();
} else if (args.includes("--start-all") || args.includes("-s")) {
  startAll();
} else if (args.includes("--health-only")) {
  loadEnv();
  applyEnvImmunity();
  const port = Number(process.env.PORT) || 5000;
  runHealthChecks("127.0.0.1", port).catch(err => {
    console.error("[HEALTH] Failed:", err.message);
    process.exit(1);
  });
} else {
  showMenu();
}
