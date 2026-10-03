#!/usr/bin/env node
// =============================================================================
// gen-openai-docs.js — regenerate the two doc artifacts from the LIVE server
//
//   docs/openai-tools.md    tool table     <- GET /api/admin/tools
//   docs/openai-schema.json tools/models/agents <- tools/list + /api/v0/models
//                                                 + GET /api/admin/agents
//
// Why: counts, model mappings and tool lists are DYNAMIC (DB-backed). Hand
// edited docs drift the moment an agent model or a tool changes. Everything
// in the regenerated sections is derived from the running gateway, so the
// docs can never disagree with the registry — tests/docs-claims.test.js
// fails the build if they do.
//
// Usage:
//   node tools/gen-openai-docs.js                 # regenerate (writes files)
//   node tools/gen-openai-docs.js --check         # verify only, exit 1 if stale
//   node tools/gen-openai-docs.js --base URL      # non-default gateway
//
// Contract (verified by tests/docs-claims.test.js):
//   - openai-tools.md row count  == live enabled tools
//   - schema.tools deep-equals OpenAI conversion of live tools/list
//   - schema.agents matches the DB-backed /api/admin/agents
//   - schema.models matches /api/v0/models
// =============================================================================

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SCHEMA_PATH = path.join(ROOT, "docs", "openai-schema.json");
const TOOLS_MD_PATH = path.join(ROOT, "docs", "openai-tools.md");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CHECK = process.argv.includes("--check");
const BASE = arg("--base", process.env.GATEWAY_BASE || "http://127.0.0.1:5000");

// /api/admin/* requires x-admin-token whenever ADMIN_TOKEN is configured
// (adminAuthorized() in api.js) — without it every admin fetch 401s.
function loadAdminToken() {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN.trim();
  try {
    const m = fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^ADMIN_TOKEN=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch (_) { /* no .env */ }
  return "";
}
const ADMIN_TOKEN = loadAdminToken();

async function getJSON(url) {
  const headers = { accept: "application/json" };
  if (ADMIN_TOKEN) headers["x-admin-token"] = ADMIN_TOKEN;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function rpc(method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`POST ${BASE}/mcp ${method} -> HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// MCP tool -> OpenAI function entry (same shape api.js serves on /v1)
function toOpenAI(t) {
  const parameters =
    t.inputSchema && typeof t.inputSchema === "object"
      ? t.inputSchema
      : { type: "object", properties: { args: { type: "object" } } };
  return { type: "function", function: { name: t.name, description: t.description || "", parameters } };
}

// docs/openai-tools.md
function renderToolsMarkdown(admin) {
  const rows = admin.tools
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const cell = (s) => String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const lines = [];
  lines.push(`# MCP Tools — Mission Barisal (${rows.length})`);
  lines.push("");
  lines.push("Generated from `GET /api/admin/tools` on the live server. Machine-readable");
  lines.push(
    "OpenAI function-calling conversion: [`openai-schema.json`](openai-schema.json).",
  );
  lines.push(
    "Regenerate after adding/removing tools: `node tools/gen-openai-docs.js`.",
  );
  lines.push("");
  lines.push("| # | Tool | Description | Enabled | Calls | Errors |");
  lines.push("|---|------|-------------|---------|-------|--------|");
  rows.forEach((t, i) => {
    const enabled = t.enabled ? "Y" : "N";
    lines.push(
      `| ${i + 1} | \`${t.name}\` | ${cell(t.description)} | ${enabled} | ${t.calls || 0} | ${t.errors || 0} |`,
    );
  });
  lines.push("");
  lines.push(`_Total: ${rows.length} tools (gateway + external). Toggles are live: disabling a tool removes it from_`);
  lines.push("`tools/list` _and refuses_ `tools/call` _at the execution choke point. Call/error_");
  lines.push("_counters are runtime stats — a snapshot at generation time._");
  lines.push("");
  return lines.join("\n");
}

function stable(value) {
  return JSON.stringify(value, null, 1);
}

async function main() {
  const [list, admin, models, agents] = await Promise.all([
    rpc("tools/list", {}),
    getJSON(`${BASE}/api/admin/tools`),
    getJSON(`${BASE}/api/v0/models`),
    getJSON(`${BASE}/api/admin/agents`),
  ]);

  const liveTools = list.tools.map(toOpenAI);
  const liveModels = (models.data || []).map((m) => ({
    id: m.id,
    object: "model",
    provider: m.owned_by,
    kind: "provider",
  }));
  const liveAgents = (agents.agents || []).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    model: a.model,
  }));

  const mdNew = renderToolsMarkdown(admin);
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  const expected = { tools: liveTools, models: liveModels, agents: liveAgents };

  // ---- staleness detection (semantic fields only; timestamps ignored) ----
  // tools + agents are STRICT: adding a tool or changing a DB agent mapping
  // must be reflected in the docs (that is the whole point of this generator).
  // models is a SNAPSHOT by design: the catalog re-syncs from the DB every few
  // minutes (observed 366 -> 359 within one run), so exact equality would make
  // --check flap; drift is reported as a note instead of a failure.
  const stale = [];
  for (const k of ["tools", "agents"]) {
    if (stable(schema[k]) !== stable(expected[k])) stale.push(k);
  }
  const modelsDiffer = stable(schema.models) !== stable(liveModels);
  // Calls/Errors are RUNTIME counters (README line: "Call/error counters are
  // runtime stats"): every tools/call bumps them, so exact text compare would
  // make --check fail seconds after regeneration. Compare semantic columns only.
  const stripCounters = (md) =>
    md.replace(/^(\| \d+ \|.*\| [YN] \|) \d+ \| \d+ \|$/gm, "$1 * | * |");
  const mdOld = fs.existsSync(TOOLS_MD_PATH) ? fs.readFileSync(TOOLS_MD_PATH, "utf8") : "";
  const mdStale = stripCounters(mdOld) !== stripCounters(mdNew);
  if (mdStale) stale.push("openai-tools.md");

  if (CHECK) {
    if (stale.length) {
      console.error(`STALE docs sections: ${stale.join(", ")}`);
      console.error("Run: node tools/gen-openai-docs.js");
      process.exit(1);
    }
    if (modelsDiffer) {
      console.warn(
        `note: schema.models snapshot drift (${schema.models.length} stored vs ${liveModels.length} live) — expected, model counts re-sync constantly; not stale`,
      );
    }
    console.log(`OK docs in sync with live gateway (${liveTools.length} tools, ${liveAgents.length} agents, ${liveModels.length} models)`);
    return;
  }

  schema.tools = liveTools;
  schema.models = liveModels;
  schema.agents = liveAgents;
  schema.generated_utc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  schema.generator = "tools/gen-openai-docs.js (live gateway)";

  fs.writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 2) + "\n");
  fs.writeFileSync(TOOLS_MD_PATH, mdNew);

  console.log(
    `regenerated: openai-tools.md (${liveTools.length} rows)` +
      ` + openai-schema.json (tools=${liveTools.length}, models=${liveModels.length}, agents=${liveAgents.length})` +
      (stale.length ? `  [was stale: ${stale.join(", ")}]` : ""),
  );
}

main().catch((err) => {
  console.error("gen-openai-docs FAILED:", err.message);
  process.exit(1);
});
