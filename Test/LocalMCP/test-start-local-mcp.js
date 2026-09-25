#!/usr/bin/env node
/**
 * test-start-local-mcp.js — contract tests for start-local-mcp.js
 * ═══════════════════════════════════════════════════════════════════════
 * Runs startLocalServers() DIRECTLY — never start.js --start-all (its
 * cleanupOldProcesses would kill the live server on port 3000).
 *
 * Tests:
 *   1. start → every servers.json local entry reports status:"ready"
 *   2. JSON-RPC tools/list round-trip on each port (loopback)
 *   3. result shape matches start.js's .filter(r => r.status === "ready")
 *   4. second call → "already-running" short circuit, no duplicate spawn
 *      (child pid set unchanged)
 *   5. parent-exit kill: a child node process that starts the servers and
 *      exits must leave NO listeners behind
 *   6. live server (:3000) untouched throughout
 *
 * Exit: 0 = all PASS, 1 = any FAIL
 */

"use strict";

const { spawn } = require("child_process");
const net = require("net");
const path = require("path");

// Shared Evidence JSON writer — every run is archived under Test/Evidence/.
const { createEvidence } = require("../lib/evidence.js");

const MOD = path.join(__dirname, "..", "..", "start-local-mcp.js");
const LIVE_PORT = 3000;

let passCount = 0, failCount = 0;
const failures = [];

const ev = createEvidence("test-start-local-mcp.js", "LocalMCP");

function ok(cond, name, extra) {
  ev.check(name, cond, extra || "");
  if (cond) { passCount++; console.log("  PASS  " + name); }
  else {
    failCount++;
    const s = extra ? "  [" + extra + "]" : "";
    failures.push(name + s);
    console.log("  FAIL  " + name + s);
  }
}
const section = (t) => console.log("\n── " + t + " " + "─".repeat(Math.max(0, 70 - t.length)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPortListening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(500);
    s.on("connect", () => fin(true));
    s.on("timeout", () => fin(false));
    s.on("error", () => fin(false));
  });
}

/**
 * JSON-RPC over HTTP. Uses fetch (handles the chunked transfer-encoding
 * these MCP servers emit); raw sockets would need manual de-chunking.
 * Returns parsed JSON body or null on any failure.
 */
async function rpc(port, body) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    return await res.json().catch(() => null);
  } catch (_) {
    return null;
  }
}

async function main() {
  console.log("start-local-mcp.js contract test");
  const { startLocalServers, stopLocalServers, getSpawnedChildren } = require(MOD);

  // Baseline: which ports were ALREADY listening before we do anything?
  const probeTargets = [3100, 3101, 3102];
  const preExisting = [];
  for (const p of probeTargets) if (await isPortListening(p)) preExisting.push(p);
  const liveBefore = await isPortListening(LIVE_PORT);
  ev.meta({
    module: MOD,
    live_port: LIVE_PORT,
    probed_ports: probeTargets,
    pre_existing_ports: preExisting,
  });
  ev.note("pre-existing listeners before test: " + (preExisting.length ? preExisting.join(",") : "none"));
  ok(liveBefore, "live server (:3000) healthy at start");

  section("1. startLocalServers() → all ready");
  const results = await startLocalServers();
  ok(results.length > 0, "returned " + results.length + " entries");
  ok(
    results.every((r) => r.status === "ready"),
    "every entry status:ready",
    results.map((r) => r.name + "=" + r.status + "(" + r.detail + ")").join(", "),
  );
  // Shape contract from start.js line 621: .filter(r => r.status === "ready")
  const readyCount = results.filter((r) => r.status === "ready").length;
  ok(readyCount === results.length, "start.js filter would count " + readyCount + "/" + results.length + " ready");

  section("2. JSON-RPC round-trip on each ready port");
  for (const r of results) {
    if (r.status !== "ready") continue;
    const parsed = await rpc(r.port, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const tools = (parsed && parsed.result && parsed.result.tools) || null;
    ok(Array.isArray(tools) && tools.length > 0, r.name + " @" + r.port + " tools/list → " + (tools ? tools.length + " tools" : "no tools"));
  }

  section("4. second call → already-running short circuit, no duplicate spawn");
  const kidsBefore = getSpawnedChildren();
  const results2 = await startLocalServers();
  const kidsAfter = getSpawnedChildren();
  ok(
    results2.every((r) => r.status === "ready"),
    "second call still all ready",
    results2.map((r) => r.name + "=" + r.detail).join(", "),
  );
  ok(
    results2.some((r) => r.detail === "already-running"),
    "at least one entry short-circuited as already-running",
    results2.map((r) => r.detail).join(","),
  );
  ok(
    kidsAfter.length === kidsBefore.length,
    "no duplicate children spawned (before " + kidsBefore.length + " → after " + kidsAfter.length + ")",
  );

  section("3. stopLocalServers() → teardown");
  await stopLocalServers();
  await sleep(500);
  for (const r of results) {
    if (r.detail === "already-running" && preExisting.includes(r.port)) {
      // we never owned this port — must still be up (we killed nothing foreign)
      ok(await isPortListening(r.port), r.name + " pre-existing @" + r.port + " NOT touched by stop()");
      continue;
    }
    ok(!(await isPortListening(r.port)), r.name + " port " + r.port + " released after stop()");
  }

  section("5. parent-exit kill — child process exits → no orphans");
  // Child node process: start servers, print ports, then exit(0).
  const childScript = `
    const m = require(${JSON.stringify(MOD)});
    m.startLocalServers().then((r) => {
      console.log("PORTS:" + JSON.stringify(r.map(x => ({ port: x.port, status: x.status, detail: x.detail }))));
      setTimeout(() => process.exit(0), 300); // exit WITHOUT stopLocalServers()
    });
  `;
  const out = await new Promise((resolve) => {
    const c = spawn(process.execPath, ["-e", childScript], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let errBuf = "";
    c.stdout.on("data", (d) => (buf += d));
    c.stderr.on("data", (d) => (errBuf += d));
    c.on("exit", () => resolve({ buf, errBuf }));
  });
  let spawned = [];
  const line = out.buf.split("\n").find((l) => l.startsWith("PORTS:"));
  if (line) {
    try { spawned = JSON.parse(line.slice(6)); } catch (_) { /* ignore */ }
  }
  ok(line !== undefined, "child reported its spawned servers", out.errBuf.slice(0, 200));
  ok(
    Array.isArray(spawned) && spawned.length > 0 && spawned.every((s) => s.status === "ready"),
    "child saw all ready: " + spawned.map((s) => s.port + "=" + s.detail).join(", "),
  );
  await sleep(600);
  let orphans = 0;
  for (const s of spawned) {
    if (s.detail === "already-running" && preExisting.includes(s.port)) continue;
    if (await isPortListening(s.port)) orphans++;
  }
  ok(orphans === 0, "after parent exit: 0 orphan listeners (process.on('exit') SIGKILL worked)");

  section("6. live server untouched");
  ok(await isPortListening(LIVE_PORT), "live server (:3000) still up");

  section("SUMMARY");
  const total = passCount + failCount;
  console.log("RESULT: " + passCount + "/" + total + (failCount === 0 ? " PASS" : " — " + failCount + " FAILED"));
  if (failures.length) {
    console.log("FAILURES:");
    failures.forEach((f) => console.log("  - " + f));
  }
  const evFile = ev.write({ module_path: MOD });
  console.log("EVIDENCE: " + evFile);
  return failCount === 0;
}

main()
  .then((s) => process.exit(s ? 0 : 1))
  .catch((e) => {
    console.error("TEST CRASHED: " + (e && e.stack ? e.stack : e));
    try {
      ev.note("CRASHED: " + ((e && e.stack) || e));
      console.log("EVIDENCE: " + ev.write({ module_path: MOD }));
    } catch (_) {
      /* evidence is best-effort on the crash path */
    }
    process.exit(1);
  });
