#!/usr/bin/env node
// =============================================================================
// docs-claims.test.js — README.md / docs/ claims vs the LIVE gateway
//
// Every number the documentation publishes (tool count, registry contents,
// agent model mappings, provider catalog shape) is checked against the
// running server on every test run. If a tool is added, an agent model is
// changed in the DB, or a doc regresses to a stale number, this fails —
// that is the anti-drift mechanism (run `node tools/gen-openai-docs.js`).
//
// Run: node tests/docs-claims.test.js   (gateway must be up on GATEWAY_BASE)
// =============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const net = require("net");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.GATEWAY_BASE || "http://127.0.0.1:5000";

const rows = [];
let pass = 0;
let fail = 0;

function assert(name, ok, detail) {
  if (ok) {
    pass++;
    rows.push(["PASS", name, detail || ""]);
  } else {
    fail++;
    rows.push(["FAIL", name, detail || ""]);
  }
}

// /api/admin/* requires x-admin-token whenever ADMIN_TOKEN is set server-side
// (adminAuthorized() in api.js). Read it from the environment or the project
// .env so this suite doesn't 401 at C3 purely because a secret exists.
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(
      /^ADMIN_TOKEN=(.+)$/m,
    );
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch (_) {
    /* no .env → run without admin endpoints */
  }
  return "";
}
const ADMIN_TOKEN = loadAdminToken();

async function getJSON(p) {
  const res = await fetch(
    BASE + p,
    ADMIN_TOKEN ? { headers: { "x-admin-token": ADMIN_TOKEN } } : undefined,
  );
  if (!res.ok) throw new Error(p + " -> HTTP " + res.status);
  return res.json();
}

async function rpc(method, params) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error("/mcp " + method + " -> HTTP " + res.status);
  const j = await res.json();
  if (j.error) throw new Error(method + ": " + JSON.stringify(j.error));
  return j.result;
}

// README claims a working UDS tools/list example — prove it over the socket.
function udsToolCount(expected) {
  return new Promise((resolve) => {
    const sock = "/tmp/zombiecoder/mcp.sock";
    if (!fs.existsSync(sock)) return resolve(false);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try {
        s.destroy();
      } catch (e) {}
      resolve(v);
    };
    const s = net.connect(sock);
    let buf = "";
    s.setTimeout(8000, () => done(false));
    s.on("error", () => done(false));
    s.on("connect", () =>
      s.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n"),
    );
    s.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const j = JSON.parse(buf.slice(0, nl));
        const tools = (j.result && j.result.tools) || [];
        done(tools.length === expected);
      } catch (e) {
        done(false);
      }
    });
  });
}

async function main() {
  // ── live: /health shape (README "Test Commands → Health") ────────────────
  const health = await getJSON("/health");
  assert(
    "C1 /health shape (healthy, version, agents, instance_id)",
    health.healthy === true &&
      typeof health.version === "string" &&
      typeof health.agents === "number" &&
      health.agents >= 1 &&
      typeof health.instance_id === "string",
    "agents=" + health.agents + " models=" + health.models,
  );

  // ── live: provider catalog shape (README /api/v0/models example) ─────────
  const models = await getJSON("/api/v0/models");
  const ids = (models && models.data) || [];
  const providers = [...new Set(ids.map((m) => m.owned_by).filter(Boolean))];
  // Floor, not a claim: README shows the shape only (`... <live> models ...`).
  // Baselines: 234 ids / 7 providers (2026-10-01) → 106 / 5 after custom_3 and
  // custom_4 were switched off via ENABLED=false in .env (honored by the loader).
  // The old hardcoded 300/8 never matched reality and failed forever.
  assert(
    "C2 /api/v0/models shape (>=100 model ids, >=5 providers)",
    ids.length >= 100 && providers.length >= 5,
    ids.length + " models, " + providers.length + " providers",
  );

  // ── live: admin registry self-consistency ────────────────────────────────
  const admin = await getJSON("/api/admin/tools");
  const enabled = admin.tools.filter((t) => t.enabled);
  assert(
    "C3 admin registry consistent (total == rows, all enabled)",
    admin.total_tools === admin.tools.length && enabled.length === admin.tools.length,
    "total=" + admin.total_tools + " enabled=" + enabled.length,
  );

  // ── live: MCP transport sees the identical registry (one choke point) ────
  const lst = await rpc("tools/list", {});
  const mcpNames = lst.tools.map((t) => t.name).sort();
  const adminNames = admin.tools.map((t) => t.name).sort();
  assert(
    "C4 tools/list == admin registry (same names across transports)",
    JSON.stringify(mcpNames) === JSON.stringify(adminNames),
    mcpNames.length + " tools",
  );
  assert(
    "C4b every MCP tool carries an object inputSchema",
    lst.tools.every((t) => t.inputSchema && t.inputSchema.type === "object"),
    "",
  );

  // ── live: UDS tools/list works as the README example claims ──────────────
  const udsOk = await udsToolCount(mcpNames.length);
  assert("C5 UDS tools/list returns the same count (README socket example)", udsOk === true, "");

  // ── docs <-> registry: tool counts published in README/docs ──────────────
  const N = admin.total_tools;
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const badge = readme.match(/MCP%20tools-(\d+)-/);
  const section = readme.match(/## MCP Tools \((\d+)\)/);
  assert(
    "C6 README badge count == live registry",
    badge && Number(badge[1]) === N,
    "badge=" + (badge && badge[1]) + " live=" + N,
  );
  assert(
    "C6b README section header == live registry",
    section && Number(section[1]) === N,
    "header=" + (section && section[1]) + " live=" + N,
  );

  const toolsMd = fs.readFileSync(path.join(ROOT, "docs", "openai-tools.md"), "utf8");
  const mdHeader = toolsMd.match(/^# MCP Tools . Mission Barisal \((\d+)\)$/m);
  const mdRows = [...toolsMd.matchAll(/^\| \d+ \| `([^`]+)` \|/gm)].map((m) => m[1]);
  const mdTotal = toolsMd.match(/_Total: (\d+) tools/);
  assert(
    "C7 openai-tools.md header/rows/total == live registry",
    mdHeader &&
      Number(mdHeader[1]) === N &&
      mdRows.length === N &&
      mdTotal &&
      Number(mdTotal[1]) === N,
    "rows=" + mdRows.length + " live=" + N,
  );
  assert(
    "C7b openai-tools.md row names == live tool names",
    JSON.stringify(mdRows.slice().sort()) === JSON.stringify(adminNames),
    "",
  );

  // ── schema: machine-readable manifest matches the live registry ──────────
  const schemaRaw = fs.readFileSync(path.join(ROOT, "docs", "openai-schema.json"), "utf8");
  const schema = JSON.parse(schemaRaw);
  const schemaNames = schema.tools.map((t) => t.function.name).sort();
  assert(
    "C8 schema.tools == live tools (count + names)",
    schema.tools.length === N && JSON.stringify(schemaNames) === JSON.stringify(adminNames),
    "schema=" + schema.tools.length + " live=" + N,
  );
  assert(
    "C8b schema.tools OpenAI shape (type:function + object parameters)",
    schema.tools.every(
      (t) => t.type === "function" && t.function && t.function.parameters && t.function.parameters.type === "object",
    ),
    "",
  );
  assert("C8c schema has no 'at15' typo", schemaRaw.indexOf("at15") < 0, "");

  // ── D1: agent rows in docs follow the DB (the original mismatch bug) ─────
  const agents = await getJSON("/api/admin/agents");
  const dbIds = agents.agents.map((a) => a.id).sort();
  const schemaIds = schema.agents.map((a) => a.id).sort();
  assert(
    "C9 schema.agents ids == DB agent ids",
    JSON.stringify(schemaIds) === JSON.stringify(dbIds),
    dbIds.length + " agents",
  );
  const dbModel = Object.fromEntries(agents.agents.map((a) => [a.id, a.model]));
  const stale = schema.agents.filter((a) => dbModel[a.id] !== a.model);
  assert(
    "C9b schema.agents model mappings == DB (stale mapping fails here)",
    stale.length === 0,
    stale.map((a) => a.id).join(",") || "all match",
  );

  // ── generator gate: --check is the anti-drift tripwire ───────────────────
  const gen = spawnSync("node", ["tools/gen-openai-docs.js", "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert(
    "C10 gen-openai-docs.js --check passes (docs in sync)",
    gen.status === 0,
    ((gen.stderr || "") + (gen.stdout || "")).trim().split("\n")[0] || "",
  );

  // ── docs hygiene: English-only, no personal paths ────────────────────────
  const docFiles = [
    path.join(ROOT, "README.md"),
    ...fs
      .readdirSync(path.join(ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => path.join(ROOT, "docs", f)),
  ];
  const BANGLA = /[\u0980-\u09FF]/;
  const bangla = docFiles.filter((f) => BANGLA.test(fs.readFileSync(f, "utf8")));
  assert(
    "C11 zero Bengali glyphs in README/docs",
    bangla.length === 0,
    bangla.map((f) => path.basename(f)).join(",") || "clean",
  );
  const PERSONAL = /\/home\/sahon|\/tmp\/opencode/;
  const personal = docFiles.filter((f) => PERSONAL.test(fs.readFileSync(f, "utf8")));
  assert(
    "C12 no personal/temp paths in README/docs",
    personal.length === 0,
    personal.map((f) => path.basename(f)).join(",") || "clean",
  );

  // ── report ───────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: docs claims vs LIVE gateway");
  console.log("  base: " + BASE);
  console.log("══════════════════════════════════════════════════════════");
  for (const [st, name, detail] of rows) {
    console.log((st === "PASS" ? "  ✅ " : "  ❌ ") + name + (detail ? "   [" + detail + "]" : ""));
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  console.error("Is the gateway running on " + BASE + "? (node start.js --start-all)");
  process.exit(1);
});
