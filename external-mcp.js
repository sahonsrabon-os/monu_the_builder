// =============================================================================
// Mission Barisal v3 — External MCP Loader
// Loads external MCP servers from TWO sources:
//   1) local files in  ./external mcp/servers.json   (folder config)
//   2) direct URLs from EXTERNAL_MCP_URLS env         (comma-separated)
// Uses MCPClientManager (mcp-client.js) for the actual JSON-RPC connection.
// =============================================================================

const path = require("path");
const fs = require("fs");
const { MCPClientManager } = require("./mcp-client.js");

const FOLDER_DIR = path.resolve(__dirname, "external mcp");
const CONFIG_FILE = path.join(FOLDER_DIR, "servers.json");

let manager = null;

// ─── Load server definitions from the folder's servers.json ──
function loadFromFolder() {
  const servers = [];
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.warn("[EXTERNAL_MCP] no config at " + CONFIG_FILE);
      return servers;
    }
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const list = data.servers || [];
    for (const s of list) {
      if (!s || !s.url) continue;
      if (s.enabled === false) continue;
      servers.push({
        name: (s.name || "").trim() || hostFromUrl(s.url),
        url: s.url.trim(),
        transport: s.transport || "http",
        token: s.token || "",
        autoConnect: s.autoConnect !== false,
        source: "folder",
      });
    }
    console.log("[EXTERNAL_MCP] folder config: " + servers.length + " server(s)");
  } catch (e) {
    console.warn("[EXTERNAL_MCP] folder config parse failed: " + e.message);
  }
  return servers;
}

// ─── Load server definitions from EXTERNAL_MCP_URLS env ──────
function loadFromUrls() {
  const servers = [];
  const raw = (process.env.EXTERNAL_MCP_URLS || "").trim();
  if (!raw) return servers;
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  for (const url of urls) {
    servers.push({
      name: hostFromUrl(url),
      url,
      transport: "http",
      token: "",
      autoConnect: true,
      source: "url",
    });
  }
  console.log("[EXTERNAL_MCP] env URLs: " + servers.length + " server(s)");
  return servers;
}

function hostFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.replace(/[^a-z0-9]/gi, "-");
  } catch (e) {
    return "external-" + Math.random().toString(36).slice(2, 8);
  }
}

// ─── Connect all servers via MCPClientManager ────────────────
async function loadAll() {
  if (!manager) manager = new MCPClientManager(console.log);
  const defs = [...loadFromFolder(), ...loadFromUrls()];
  const results = [];
  for (const def of defs) {
    try {
      const res = await manager.connectServer(def.name, def.url, {
        transport: def.transport,
        token: def.token,
        autoConnect: def.autoConnect,
      });
      results.push({ name: def.name, ...res, source: def.source });
    } catch (e) {
      results.push({ name: def.name, error: e.message, source: def.source });
    }
  }
  return results;
}

// ─── Tools from all connected external servers ───────────────
function getAllTools() {
  return manager ? manager.getAllExternalTools() : [];
}

// ─── Call an external tool: <server>__<tool> ─────────────────
async function call(name, tool, args) {
  return manager ? manager.callExternalTool(name, tool, args || {}) : null;
}

// ─── Parse a full tool name like  server__tool  ──────────────
function parseToolName(fullName) {
  const idx = fullName.indexOf("__");
  if (idx === -1) return null;
  return { server: fullName.slice(0, idx), tool: fullName.slice(idx + 2) };
}

// ─── Server status list (for /api/mcp-external) ──────────────
function getStatus() {
  return manager
    ? manager.listServers().map((s) => ({
        name: s.name,
        url: s.url,
        status: s.status,
        tools: (s.tools || []).length,
        lastSeen: s.lastSeen,
        error: s.error || null,
      }))
    : [];
}

function getManager() {
  return manager;
}

module.exports = {
  loadAll,
  getAllTools,
  call,
  parseToolName,
  getStatus,
  getManager,
  CONFIG_FILE,
};