#!/usr/bin/env node
/**
 * start-local-mcp.js — child-module launcher for local MCP servers
 * ═══════════════════════════════════════════════════════════════════════
 * Consumed by start.js (step 8):
 *
 *     const { startLocalServers } = require("./start-local-mcp.js");
 *     const mcpResults = await startLocalServers();
 *     const readyCount = mcpResults.filter(r => r.status === "ready").length;
 *
 * Contract:
 *   - Reads "external mcp/servers.json", spawns every entry with
 *     local:true && enabled:true && a script path.
 *   - Binds stay loopback-only (the scripts themselves listen on
 *     127.0.0.1; we additionally pin the contract-table port env vars):
 *         ocr → OCR_MCP_PORT (3100)
 *         screen-recorder → SCREEN_MCP_PORT (3101)
 *         tts → TTS_MCP_PORT (3102)
 *   - Readiness = TCP accept on 127.0.0.1:<port> (polled, bounded).
 *   - "already-running" short circuit: if the port is already accepting
 *     (server up from a previous run / another manager), we do NOT spawn
 *     a duplicate — result is still status:"ready".
 *   - Children are killed when this process exits:
 *       * process.on("exit")  → synchronous SIGKILL (works for
 *         process.exit() and normal termination),
 *       * non-detached spawn  → children share our process group, so a
 *         terminal Ctrl-C (SIGINT to the foreground group) reaches them
 *         too.
 *   - Returns [{ name, status: "ready" | "error", port, detail }].
 *     detail: "spawned" | "already-running" | "timeout" | "exited"
 *             | "script-missing".
 *
 * Safety: never kills anything it did not spawn; never touches the live
 * server port; never uses cleanupOldProcesses-style pkill sweeps.
 *
 * Standalone: `node start-local-mcp.js` runs a built-in smoke test
 * (spawn → JSON-RPC round-trip → stop) and exits.
 */

"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = __dirname;
const SERVERS_JSON = path.join(ROOT, "external mcp", "servers.json");
const READY_TIMEOUT_MS = parseInt(process.env.MCP_READY_TIMEOUT_MS || "15000", 10);
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 500;

// Contract-table port env vars (name → env key). Unknown local servers
// fall back to <NAME>_MCP_PORT.
const PORT_ENV_BY_NAME = {
  ocr: "OCR_MCP_PORT",
  "screen-recorder": "SCREEN_MCP_PORT",
  tts: "TTS_MCP_PORT",
};

/** name → child process (only entries WE spawned) */
const children = new Map();
let exitHookInstalled = false;

function log(msg) {
  console.log("[LOCAL-MCP] " + msg);
}

// ─── servers.json ─────────────────────────────────────────────────────
function loadLocalServerEntries() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SERVERS_JSON, "utf8"));
  } catch (e) {
    log("WARN cannot read " + SERVERS_JSON + ": " + e.message);
    return [];
  }
  const list = Array.isArray(raw.servers) ? raw.servers : [];
  return list
    .filter((s) => s && s.local === true && s.enabled !== false && s.script)
    .map((s) => {
      let port = 0;
      try {
        port = Number(new URL(s.url).port) || 0;
      } catch (_) {
        /* url parse failure → port 0 → error below */
      }
      return {
        name: String(s.name),
        script: path.resolve(ROOT, s.script),
        port,
        portEnv:
          PORT_ENV_BY_NAME[s.name] ||
          String(s.name).toUpperCase().replace(/-/g, "_") + "_MCP_PORT",
      };
    });
}

// ─── TCP readiness probe ──────────────────────────────────────────────
function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function waitForPort(port, deadline) {
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return await isPortListening(port);
}

// ─── exit hooks (kill only OUR children) ──────────────────────────────
function killAllSync() {
  for (const [, child] of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    } catch (_) {
      /* already dead */
    }
  }
}

function installExitHooks() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killAllSync);
}

// ─── spawn one entry ──────────────────────────────────────────────────
function spawnEntry(entry) {
  if (!fs.existsSync(entry.script)) {
    return {
      name: entry.name, status: "error", port: entry.port,
      detail: "script-missing (" + entry.script + ")",
    };
  }

  const logDir = process.env.LOG_DIR || path.join(ROOT, "logs");
  let logStream = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logStream = fs.createWriteStream(
      path.join(logDir, "local-mcp-" + entry.name + ".log"),
      { flags: "a" },
    );
  } catch (_) {
    /* logging is best-effort */
  }

  const env = { ...process.env };
  env[entry.portEnv] = String(entry.port); // contract-table pin

  const child = spawn(process.execPath, [entry.script], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"], // non-detached: shares our group
  });
  if (logStream) {
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
  }
  child.on("error", (e) => log("spawn error " + entry.name + ": " + e.message));
  children.set(entry.name, child);
  installExitHooks();
  return { child };
}

// ─── public API ───────────────────────────────────────────────────────
/**
 * Start every local MCP server from servers.json.
 * Non-blocking: resolves once each server accepted TCP (bounded), so the
 * parent (start.js) continues booting without waiting on stuck children.
 * @returns {Promise<Array<{name:string,status:string,port:number,detail:string}>>}
 */
async function startLocalServers() {
  const entries = loadLocalServerEntries();
  const results = [];

  for (const entry of entries) {
    if (!entry.port) {
      results.push({
        name: entry.name, status: "error", port: 0,
        detail: "bad-url (no port)",
      });
      continue;
    }

    // Already-running short circuit — no duplicate spawn.
    if (await isPortListening(entry.port)) {
      log(entry.name + " already-running on 127.0.0.1:" + entry.port);
      results.push({
        name: entry.name, status: "ready", port: entry.port,
        detail: "already-running",
      });
      continue;
    }

    // Restart within same process (defensive): reuse existing child.
    const existing = children.get(entry.name);
    if (existing && existing.exitCode === null) {
      const ready = await waitForPort(entry.port, Date.now() + READY_TIMEOUT_MS);
      results.push({
        name: entry.name, status: ready ? "ready" : "error", port: entry.port,
        detail: ready ? "spawned" : "timeout",
      });
      continue;
    }

    const spawned = spawnEntry(entry);
    if (spawned.status) {
      results.push(spawned);
      log(entry.name + " " + spawned.detail);
      continue;
    }

    const deadline = Date.now() + READY_TIMEOUT_MS;
    const child = spawned.child;
    let earlyExit = null;
    const onExit = (code, sig) => {
      earlyExit = "exited (code=" + code + " signal=" + sig + ")";
    };
    child.once("exit", onExit);

    let ready = false;
    while (!earlyExit && Date.now() < deadline) {
      if (await isPortListening(entry.port)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
    }
    child.removeListener("exit", onExit);

    if (ready) {
      log(entry.name + " ready on 127.0.0.1:" + entry.port + " (pid " + child.pid + ")");
      results.push({
        name: entry.name, status: "ready", port: entry.port, detail: "spawned",
      });
    } else {
      const detail = earlyExit || "timeout";
      log(entry.name + " FAILED: " + detail);
      if (!earlyExit) {
        try {
          child.kill("SIGKILL");
        } catch (_) {
          /* already dead */
        }
        children.delete(entry.name);
      }
      results.push({ name: entry.name, status: "error", port: entry.port, detail });
    }
  }

  return results;
}

/**
 * Stop every child WE spawned (idempotent). Used by tests and by
 * embedders that want deterministic teardown.
 */
async function stopLocalServers() {
  const names = [...children.keys()];
  for (const name of names) {
    const child = children.get(name);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      children.delete(name);
      continue;
    }
    try {
      child.kill("SIGTERM");
    } catch (_) {
      /* already dead */
    }
  }
  // Grace window, then SIGKILL stragglers.
  const deadline = Date.now() + 3000;
  while (children.size > 0 && Date.now() < deadline) {
    let alive = 0;
    for (const [name, child] of children) {
      if (child.exitCode === null && child.signalCode === null) alive++;
      else children.delete(name);
    }
    if (alive === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const [, child] of children) {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* already dead */
    }
  }
  children.clear();
  return names;
}

/** Snapshot of children WE spawned: [{name, pid}] */
function getSpawnedChildren() {
  return [...children.entries()].map(([name, c]) => ({ name, pid: c.pid }));
}

// ─── standalone smoke test (node start-local-mcp.js) ──────────────────
async function standaloneSmoke() {
  log("standalone smoke: start → verify → stop");
  const results = await startLocalServers();
  let fail = 0;
  const ok = (cond, msg) => {
    console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
    if (!cond) fail++;
  };

  ok(results.length > 0, "entries found in servers.json: " + results.length);
  ok(
    results.every((r) => r.status === "ready"),
    "all local MCP servers ready: " + results.map((r) => r.name + "=" + r.status + "(" + r.detail + ")").join(", "),
  );

  for (const r of results) {
    if (r.status !== "ready") continue;
    // fetch handles the chunked transfer-encoding these servers use.
    let tools = null;
    try {
      const res = await fetch("http://127.0.0.1:" + r.port + "/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        signal: AbortSignal.timeout(5000),
      });
      const parsed = await res.json().catch(() => null);
      tools = (parsed && parsed.result && parsed.result.tools) || null;
    } catch (_) { /* unreachable */ }
    ok(
      Array.isArray(tools) && tools.length > 0,
      r.name + " JSON-RPC tools/list → " + (tools ? tools.length + " tools" : "no tools"),
    );
  }

  await stopLocalServers();
  await new Promise((r) => setTimeout(r, 400));
  for (const r of results) {
    if (r.status !== "ready" || r.detail === "already-running") continue;
    const stillUp = await isPortListening(r.port);
    ok(!stillUp, r.name + " stopped, port " + r.port + " released");
  }

  console.log(
    results.length > 0 && fail === 0
      ? "START-LOCAL-MCP SMOKE: " + (results.length * 2) + "/" + (results.length * 2) + " PASS"
      : "START-LOCAL-MCP SMOKE: " + fail + " FAILED",
  );
  return fail === 0;
}

module.exports = {
  startLocalServers,
  stopLocalServers,
  getSpawnedChildren,
};

if (require.main === module) {
  standaloneSmoke()
    .then((success) => process.exit(success ? 0 : 1))
    .catch((e) => {
      console.error("SMOKE CRASHED: " + (e && e.stack ? e.stack : e));
      process.exit(1);
    });
}
