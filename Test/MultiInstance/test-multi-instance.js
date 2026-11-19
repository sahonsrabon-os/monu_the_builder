#!/usr/bin/env node
/**
 * test-multi-instance.js — Mission Barisal multi-instance non-blocking test
 * ═══════════════════════════════════════════════════════════════════════
 * Proves the SAME server binary (api.js) can run on N different ports on
 * one computer simultaneously, without blocking each other or the live
 * production server (port 3000).
 *
 * Safety contract (hard rules):
 *   - NEVER spawns start.js / --start-all (its cleanupOldProcesses would
 *     kill the live server).
 *   - NEVER touches PID on port 3000 except read-only GET /health.
 *   - Only kills child PIDs this script itself spawned.
 *   - Full isolation per instance: DATA_DIR/LOG_DIR/LOCK_DIR/CACHE_DIR/
 *     UDS_PATH/cwd/.env all inside a per-run temp dir.
 *
 * Fingerprints: every run derives its ids from one random UUID (RUN_UUID).
 *   INSTANCE_ID = "<RUN_UUID>-i<n>" — asserted verbatim in /health output,
 *   so a passing test proves per-run identity, not just "some server".
 *
 * Tests:
 *   1. parallel boot          — both instances healthy, unique instance_id,
 *                               distinct free ports, Host-based domain
 *   2. HTTP/1.1 regression     — plain GET still works alongside h2c
 *   3. non-blocking burst      — 40 concurrent requests split across both
 *                               instances; all 200, wall time bounded
 *   4. h2c prior-knowledge     — HTTP/2 cleartext on the SAME port:
 *                               GET /health + POST /mcp initialize,
 *                               :authority→Host normalization asserted
 *   5. handshake ensure (HTTP) — .zombiecoder/ deleted → recreated by MCP
 *                               initialize + working_dir reported;
 *                               clients.json flushed by debounced buffer
 *   6. handshake ensure (UDS)  — same guarantees over the Unix socket,
 *                               zombiecoder_dir field asserted
 *   7. AGENT_FS_SCOPE          — read_file("/etc/hostname") via MCP
 *                               tools/call = root FS access works
 *   8. live server untouched   — port 3000 still healthy, uptime not reset
 *   9. cleanup                 — SIGTERM→exit, ports released, UDS sockets
 *                               unlinked (SIGKILL fallback)
 *
 * Usage:  node test-multi-instance.js [N]     (N = instances, default 2)
 * Exit:   0 = all PASS, 1 = any FAIL
 */

"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const http2 = require("http2");
const net = require("net");
const path = require("path");

// Shared Evidence JSON writer — every run is archived under Test/Evidence/.
const { createEvidence } = require("../lib/evidence.js");

// ─── Config ───────────────────────────────────────────────────────────
const API_JS = "/home/sahon/vs/api.js";
const SRC_ENV = "/home/sahon/vs/.env";
const PERSONAS_FILE = "/home/sahon/vs/PERSONAS.md";
const LIVE_PORT = 3000;

const RUN_UUID = crypto.randomUUID(); // per-run random fingerprint
const FP = RUN_UUID.slice(0, 8);
const ROOT = path.join("/tmp/opencode", "mi-" + FP);
const N_INSTANCES = Math.max(1, Math.min(4, parseInt(process.argv[2] || "2", 10)));
const BURST_TOTAL = 40;
const HEALTH_TIMEOUT_MS = 45000;
const CLIENTS_FLUSH_WAIT_MS = 1400; // CLIENTS_FLUSH_MS=300 + margin

// Ports that must never be picked (live server + external MCP contract table)
const RESERVED = new Set([
  3000, 3001, 3002, 3100, 3101, 3102, 3105, 9998,
  3306, 33060, 9222, 5100, 11434, 5010, 8080, 4173, 5173,
]);

// ─── Tiny assertion harness ───────────────────────────────────────────
let passCount = 0;
let failCount = 0;
const failures = [];

const ev = createEvidence("test-multi-instance.js", "MultiInstance");

function ok(cond, name, extra) {
  ev.check(name, cond, extra || "");
  if (cond) {
    passCount++;
    console.log("  PASS  " + name);
  } else {
    failCount++;
    const suffix = extra ? "  [" + extra + "]" : "";
    failures.push(name + suffix);
    console.log("  FAIL  " + name + suffix);
  }
}

function section(title) {
  console.log("\n── " + title + " " + "─".repeat(Math.max(0, 70 - title.length)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Networking helpers ───────────────────────────────────────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => (RESERVED.has(p) ? attempt() : resolve(p)));
      });
    };
    attempt();
  });
}

function request(opts, body) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = http.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, text: data, json, ms: Date.now() - t0 });
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const httpGet = (port, p) =>
  request({ host: "127.0.0.1", port, path: p, method: "GET" });

const httpPost = (port, p, body) =>
  request({
    host: "127.0.0.1",
    port,
    path: p,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, body);

/**
 * HTTP/2 cleartext (prior knowledge) request — this is exactly what the
 * in-server TCP sniffer sees: the client speaks h2 directly, no upgrade.
 */
function h2Request(port, opts) {
  const { method = "GET", path: reqPath = "/", body = null, headers = {} } = opts || {};
  return new Promise((resolve, reject) => {
    const client = http2.connect("http://127.0.0.1:" + port);
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (_) { /* already closed */ }
      if (err) reject(err);
      else resolve(val);
    };
    client.on("error", (e) => done(e));
    const t0 = Date.now();
    const req = client.request({
      ":method": method,
      ":path": reqPath,
      ":scheme": "http",
      ":authority": "127.0.0.1:" + port,
      ...headers,
    });
    req.setTimeout(15000, () => done(new Error("h2 request timeout")));
    let data = "";
    let status = 0;
    req.on("response", (h) => (status = parseInt(h[":status"], 10) || 0));
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(data); } catch (_) { /* not json */ }
      done(null, { status, text: data, json, ms: Date.now() - t0 });
    });
    req.on("error", (e) => done(e));
    if (body) req.write(body);
    req.end();
  });
}

/** One-shot newline-delimited JSON-RPC over a Unix domain socket. */
function udsRpc(sockPath, message) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: sockPath });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("uds timeout"));
    }, 5000);
    sock.on("connect", () => sock.write(JSON.stringify(message) + "\n"));
    sock.on("data", (c) => {
      buf += c.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        try { resolve(JSON.parse(buf.slice(0, nl))); }
        catch (e) { reject(e); }
        sock.end();
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function waitHealthy(port, label, logFile) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await httpGet(port, "/health");
      if (r.status === 200 && r.json && r.json.healthy === true) return r.json;
      lastErr = "status " + r.status;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(350);
  }
  throw new Error(label + " /health not ready in " + HEALTH_TIMEOUT_MS + "ms (" + lastErr + ") — see " + logFile);
}

function tailLog(logFile, lines) {
  try {
    const all = fs.readFileSync(logFile, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch (e) {
    return "(log unreadable: " + e.message + ")";
  }
}

// ─── Instance management ──────────────────────────────────────────────
function spawnInstance(n, port) {
  const instDir = path.join(ROOT, "inst" + n);
  const udsPath = path.join(instDir, "mcp.sock");
  const logFile = path.join(instDir, "server.log");
  fs.mkdirSync(instDir, { recursive: true });

  // Copy .env but strip APP_URL/DEPLOY_DOMAIN so domain detection falls
  // through to the request Host/:authority — that is what lets us ASSERT
  // the h2c :authority→Host normalization end-to-end.
  const envSrc = fs.readFileSync(SRC_ENV, "utf8");
  const envFiltered = envSrc
    .split("\n")
    .filter((l) => !/^\s*(APP_URL|DEPLOY_DOMAIN)\s*=/.test(l))
    .join("\n");
  fs.writeFileSync(path.join(instDir, ".env"), envFiltered);

  const env = { ...process.env };
  delete env.APP_URL;
  delete env.DEPLOY_DOMAIN;
  Object.assign(env, {
    PORT: String(port),
    INSTANCE_ID: RUN_UUID + "-i" + n,
    DATA_DIR: path.join(instDir, "data"),
    LOG_DIR: path.join(instDir, "logs"),
    LOCK_DIR: path.join(instDir, "locks"),
    CACHE_DIR: path.join(instDir, "cache"),
    UDS_PATH: udsPath,
    ZOMBIE_UDS_PATH: path.join(instDir, "zc.sock"),
    PERSONAS_FILE,
    BROKER_AUTORUN: "0", // no php-broker side processes
    CLIENTS_FLUSH_MS: "300", // fast flush so the buffer test is quick
    MB_WORKING_DIR: instDir, // deterministic mcpWorkingDir
    AGENT_FS_SCOPE: "unrestricted",
  });

  // NEVER --start-all, NEVER start.js: plain api.js only.
  const child = spawn(process.execPath, [API_JS], {
    cwd: instDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);

  const rec = {
    n, port, instDir, udsPath, logFile, child,
    expectedId: RUN_UUID + "-i" + n,
    exited: false, exitCode: null, exitSignal: null,
  };
  child.on("exit", (code, sig) => {
    rec.exited = true;
    rec.exitCode = code;
    rec.exitSignal = sig;
  });
  child.on("error", (e) => {
    console.log("  spawn error inst" + n + ": " + e.message);
  });
  return rec;
}

async function shutdownInstance(i) {
  if (i.exited) return;
  i.child.kill("SIGTERM");
  const deadline = Date.now() + 8000;
  while (!i.exited && Date.now() < deadline) await sleep(150);
  if (!i.exited) {
    i.child.kill("SIGKILL");
    await sleep(600);
  }
}

function portIsClosed(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.setTimeout(1500);
    s.on("connect", () => { s.destroy(); resolve(false); });
    s.on("error", () => resolve(true));
    s.on("timeout", () => { s.destroy(); resolve(true); });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  console.log("Mission Barisal — multi-instance non-blocking test");
  console.log("RUN_UUID: " + RUN_UUID);
  console.log("ROOT:     " + ROOT);
  console.log("instances: " + N_INSTANCES);

  fs.mkdirSync(ROOT, { recursive: true });

  // Baseline: live production server must be healthy BEFORE we touch anything
  const liveStart = await httpGet(LIVE_PORT, "/health").catch(() => null);
  ev.meta({
    run_uuid: RUN_UUID,
    root: ROOT,
    instances: N_INSTANCES,
    burst_total: BURST_TOTAL,
  });
  if (liveStart && liveStart.json) {
    ev.meta({
      live_server: {
        version: liveStart.json.version,
        instance_id: liveStart.json.instance_id || null,
        domain: liveStart.json.domain,
        uptime: liveStart.json.uptime,
      },
    });
  }
  ok(
    !!(liveStart && liveStart.json && liveStart.json.healthy === true),
    "live server (:" + LIVE_PORT + ") healthy at start",
    liveStart ? "code " + liveStart.status : "no response"
  );
  const liveStartUptime = liveStart && liveStart.json ? liveStart.json.uptime : null;

  // Spawn all instances concurrently — spawning must not serialize/block
  const t0 = Date.now();
  const instances = [];
  for (let n = 1; n <= N_INSTANCES; n++) {
    const port = await freePort();
    instances.push(spawnInstance(n, port));
  }
  console.log("spawned: " + instances.map((i) => "inst" + i.n + ":PID" + i.child.pid + ":port" + i.port).join(", "));

  section("1. parallel boot — concurrent health, unique per-run fingerprints");
  const healths = await Promise.all(
    instances.map((i) => waitHealthy(i.port, "inst" + i.n, i.logFile).then((h) => ({ i, h })))
  );
  const bootMs = Date.now() - t0;

  for (const { i, h } of healths) {
    ok(h.healthy === true, "inst" + i.n + " /health healthy=true");
    ok(
      h.instance_id === i.expectedId,
      "inst" + i.n + " instance_id = RUN_UUID fingerprint",
      "got " + h.instance_id + ", want " + i.expectedId
    );
    ok(
      h.domain === "127.0.0.1",
      "inst" + i.n + " domain from Host header = 127.0.0.1",
      "got " + h.domain
    );
  }
  const ids = new Set(healths.map((x) => x.h.instance_id));
  ok(ids.size === N_INSTANCES, "instance_ids unique across " + N_INSTANCES + " instances", [...ids].join(" | "));
  const ports = new Set(instances.map((i) => i.port));
  ok(ports.size === N_INSTANCES, "instances on distinct ports", [...ports].join(","));
  ok(
    instances.every((i) => !RESERVED.has(i.port) && i.port !== LIVE_PORT),
    "no port overlaps live/external services"
  );
  ok(instances.every((i) => !i.exited), "no instance crashed during boot");
  console.log("  info: all " + N_INSTANCES + " instances up in " + bootMs + "ms (concurrent spawn+boot)");
  ev.note("all " + N_INSTANCES + " instances up in " + bootMs + "ms (concurrent spawn+boot)");

  section("2. HTTP/1.1 regression — plain requests still work next to h2c");
  for (const i of instances) {
    const r = await httpGet(i.port, "/health");
    ok(
      r.status === 200 && r.json && r.json.healthy === true && r.json.instance_id === i.expectedId,
      "inst" + i.n + " h1 GET /health 200 + correct instance_id"
    );
  }

  section("3. non-blocking burst — " + BURST_TOTAL + " concurrent requests across both instances");
  const b0 = Date.now();
  const burst = await Promise.all(
    Array.from({ length: BURST_TOTAL }, (_, k) => {
      const inst = instances[k % instances.length];
      return httpGet(inst.port, "/health").then((r) => ({ inst, r }));
    })
  );
  const burstMs = Date.now() - b0;
  const allOk = burst.every(
    (x) => x.r.status === 200 && x.r.json && x.r.json.instance_id === x.inst.expectedId
  );
  const perInst = instances.map((i) => burst.filter((x) => x.inst === i).length);
  ok(allOk, "burst: all " + BURST_TOTAL + " responses 200 with correct per-instance identity");
  ok(perInst.every((c) => c > 0), "burst hit every instance concurrently", perInst.join("/") + " (req per instance)");
  ok(burstMs < 5000, "burst wall time " + burstMs + "ms < 5000ms — instances not blocking each other");
  const maxMs = Math.max(...burst.map((x) => x.r.ms));
  ok(maxMs < 3000, "max per-request latency under load: " + maxMs + "ms < 3000ms");

  section("4. HTTP/2 cleartext (h2c prior-knowledge) on the SAME port");
  for (const i of instances) {
    const r = await h2Request(i.port, { method: "GET", path: "/health" });
    ok(
      r.status === 200 && r.json && r.json.instance_id === i.expectedId,
      "inst" + i.n + " h2c GET /health 200 + instance_id",
      "status " + r.status + " " + (r.text || "").slice(0, 120)
    );
    ok(
      r.json && r.json.domain === "127.0.0.1",
      "inst" + i.n + " h2c :authority→Host normalization (domain=127.0.0.1)",
      "got " + (r.json && r.json.domain)
    );
  }
  const inst1 = instances[0];
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "h2c-test-" + FP, version: "1.0" },
    },
  });
  const h2init = await h2Request(inst1.port, {
    method: "POST",
    path: "/mcp",
    body: initBody,
    headers: { "content-type": "application/json" },
  });
  ok(
    h2init.status === 200 && h2init.json && h2init.json.result && h2init.json.result.serverInfo,
    "h2c POST /mcp initialize → JSON-RPC result",
    "status " + h2init.status + " " + (h2init.text || "").slice(0, 200)
  );
  ok(
    h2init.json && h2init.json.result && h2init.json.result.serverInfo.working_dir === inst1.instDir,
    "h2c initialize working_dir = instance dir",
    "got " + (h2init.json && h2init.json.result && h2init.json.result.serverInfo && h2init.json.result.serverInfo.working_dir)
  );

  section("5. MCP handshake (HTTP) ensures .zombiecoder/ + buffered client persistence");
  const zz1 = path.join(inst1.instDir, ".zombiecoder");
  fs.rmSync(zz1, { recursive: true, force: true });
  ok(!fs.existsSync(zz1), "precondition: inst1 .zombiecoder removed before handshake");
  const clientName = "mi-" + FP;
  const hBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: clientName, version: "1.0" },
    },
  });
  const hr = await httpPost(inst1.port, "/mcp", hBody);
  ok(hr.status === 200 && hr.json && hr.json.result, "HTTP initialize 200", (hr.text || "").slice(0, 200));
  ok(
    hr.json && hr.json.result && hr.json.result.serverInfo && hr.json.result.serverInfo.working_dir === inst1.instDir,
    "HTTP initialize working_dir = instance dir",
    "got " + (hr.json && hr.json.result && hr.json.result.serverInfo && hr.json.result.serverInfo.working_dir)
  );
  ok(
    fs.existsSync(path.join(zz1, "SSOT.md")),
    "handshake recreated .zombiecoder/SSOT.md in instance cwd"
  );
  await sleep(CLIENTS_FLUSH_WAIT_MS); // let the debounced buffer flush
  let clients = [];
  try {
    clients = JSON.parse(fs.readFileSync(path.join(inst1.instDir, "data", "clients.json"), "utf8"));
  } catch (_) { /* missing = assertion fails below */ }
  ok(
    Array.isArray(clients) && clients.some((c) => c.name === clientName),
    "clients.json flushed with '" + clientName + "' (debounced buffer persisted)",
    Array.isArray(clients) ? "entries: " + clients.map((c) => c.name).join(",") : "file unreadable"
  );

  section("6. MCP handshake (UDS) ensures .zombiecoder/ + working dir over Unix socket");
  const inst2 = instances[1] || instances[0];
  const zz2 = path.join(inst2.instDir, ".zombiecoder");
  fs.rmSync(zz2, { recursive: true, force: true });
  ok(!fs.existsSync(zz2), "precondition: inst2 .zombiecoder removed before UDS handshake");
  let u = null;
  try {
    u = await udsRpc(inst2.udsPath, {
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "uds-test-" + FP, version: "1.0" },
      },
    });
  } catch (e) {
    ok(false, "UDS initialize RPC reached", e.message);
  }
  if (u) {
    ok(!!(u.result && u.result.serverInfo), "UDS initialize JSON-RPC response");
    ok(
      u.result && u.result.serverInfo && u.result.serverInfo.working_dir === inst2.instDir,
      "UDS working_dir = instance dir",
      "got " + (u.result && u.result.serverInfo && u.result.serverInfo.working_dir)
    );
    ok(
      u.result && u.result.serverInfo && u.result.serverInfo.zombiecoder_dir === zz2,
      "UDS zombiecoder_dir reported",
      "got " + (u.result && u.result.serverInfo && u.result.serverInfo.zombiecoder_dir)
    );
    ok(fs.existsSync(path.join(zz2, "SSOT.md")), "UDS handshake recreated .zombiecoder/SSOT.md");
  }

  section("7. AGENT_FS_SCOPE unrestricted — root filesystem read via MCP tools/call");
  let hostname = "";
  try { hostname = fs.readFileSync("/etc/hostname", "utf8").trim(); } catch (_) { /* fallback below */ }
  const fsBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "read_file", arguments: { path: "/etc/hostname" } },
  });
  const fr = await httpPost(inst1.port, "/mcp", fsBody);
  const frText =
    fr.json && fr.json.result && Array.isArray(fr.json.result.content)
      ? fr.json.result.content.map((c) => c.text || "").join("\n")
      : "";
  const rootFsOk = fr.status === 200 && hostname && frText.includes(hostname);
  if (!rootFsOk) {
    console.log("  info: read_file response: " + JSON.stringify(fr.json).slice(0, 300));
  }
  ok(rootFsOk, "read_file('/etc/hostname') returned file content — root FS access active");

  section("8. live production server (:" + LIVE_PORT + ") untouched by all of the above");
  const liveEnd = await httpGet(LIVE_PORT, "/health").catch(() => null);
  ok(
    !!(liveEnd && liveEnd.json && liveEnd.json.healthy === true),
    "live server still healthy after tests"
  );
  const uptimeKept =
    liveStartUptime !== null && liveEnd && liveEnd.json &&
    typeof liveEnd.json.uptime === "number" &&
    liveEnd.json.uptime >= liveStartUptime;
  ok(
    uptimeKept,
    "live uptime not reset (start " + liveStartUptime + "s → end " +
      (liveEnd && liveEnd.json ? liveEnd.json.uptime : "?") + "s — no restart)",
  );

  section("9. cleanup — SIGTERM → graceful exit, ports + sockets released");
  await Promise.all(instances.map(shutdownInstance));
  for (const i of instances) {
    ok(i.exited, "inst" + i.n + " exited (code=" + i.exitCode + " signal=" + i.exitSignal + ")");
    const closed = await portIsClosed(i.port);
    ok(closed, "inst" + i.n + " port " + i.port + " released");
    ok(!fs.existsSync(i.udsPath), "inst" + i.n + " UDS socket unlinked");
  }

  // ─── Summary ───────────────────────────────────────────────────────
  section("SUMMARY");
  console.log("RUN_UUID: " + RUN_UUID);
  const total = passCount + failCount;
  console.log("RESULT: " + passCount + "/" + total + (failCount === 0 ? " PASS" : " — " + failCount + " FAILED"));
  if (failures.length) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log("  - " + f));
  }
  console.log("artifacts: " + ROOT);
  const evFile = ev.write({ root: ROOT, run_uuid: RUN_UUID });
  console.log("EVIDENCE: " + evFile);
  return failCount === 0;
}

main()
  .then((success) => {
    // Belt & braces: nothing of ours may survive this script.
    process.exit(success ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nTEST CRASHED: " + (err && err.stack ? err.stack : err));
    try {
      ev.note("CRASHED: " + ((err && err.stack) || err));
      console.log("EVIDENCE: " + ev.write({ root: ROOT, run_uuid: RUN_UUID }));
    } catch (_) {
      /* evidence is best-effort on the crash path */
    }
    process.exit(1);
  });
