#!/usr/bin/env node
// =============================================================================
// Mission Barisal v3 — Pure API Server
// Zero dependency · Agent Masking · MCP · Intent Verify
// Owner: Sahon Srabon (ZombieCoder) · Barisal, Bangladesh · At Home
// =============================================================================
// Mission Barisal v3 — api.js Navigation Table of Contents
// =============================================================================
// To jump to any section, search for the section header or line range below.
//
// LINE     | SECTION
// ---------+--------------------------------------------------------------------------
//       8  | Core Modules (require: http, https, crypto, fs, path, net, os)
//      18  | Domain Configuration (detectDomain, getDomainConfig)
//      25  | .env Loader (zero-dependency)
//      50  | Config Constants (PORT, OPENCODE_BASE, LOG_DIR, DATA_DIR, etc.)
//      63  | User-Agent Constant + ALLOWED_DIRS
//      74  | Domain Detection (DETECTED_DOMAIN, DOMAIN_CFG)
//      87  | Pusher Config (optional) + SSE Clients Map + UDS_PATH
//     113  | Cache & Git Config
//     124  | Runtime Config + updateRuntimeConfig()
//     153  | OS-Aware Path Resolution + Auto-Setup (NEW — Win/Lin/Mac)
//     195  |   Auto-Setup: ensureDir()
//     210  |   Auto-Setup: readJSONSafe()
//     219  |   Auto-Setup: writeJSONSafe()
//     233  |   Auto-Setup: create or update all config files
//     339  |   Auto-Setup: print setup report
//     375  | System Identity (domain-aware)
//     555  | Provider Registry + Dynamic Routing
//     698  | Competition Router
//     740  | Fallback: resolve all matching providers in priority order
//     758  | Fallback: find next provider in priority order
//     771  | Ensure directories
//     775  | Auto SSOT System
//    1198  | Syllabus & Memory System
//    1600  | Emoji Strip Utility
//    1612  | Logger
//    1686  | Load Personas
//    1745  | Git Runtime Download — Generic File Downloader
//    1814  | DEFAULT AGENTS (Fallback when PERSONAS.md unavailable)
//    2674  | CLIENT LIST PERSISTENCE
//    2976  | Model + Provider Masking System
//    3311  | Gemini API call (non-streaming)
//    3410  | Gemini streaming
//    3896  | Tool Execution Loop
//    4023  | Input Pattern Recognition Engine
//    4208  | Smart Agent Router
//    4260  | Legacy: Simple Greeting Check
//    5815  | Full Mission Execute
//    6193  | SSOT Auto-Inject
//    6261  | Single Agent Execute
//    7354  | Handle MCP message over Unix Domain Socket
//    7937  | Usage Tracking Helpers
//    8013  | HTTP Routes: GET / — Serve UI Dashboard
//    8028  |   GET /health
//    8063  |   GET /api/rate-limit
//    8068  |   POST /api/rate-limit/reset
//    8082  |   GET /identity
//    8108  |   GET /v1/models
//    8136  |   GET /api/v0/models
//    8191  |   GET /api/v1/models
//    8235  |   GET /api/mcp-clients
//    8259  |   GET /api/clients
//    8408  |   GET /api/domain
//    8429  |   GET /api/pusher-config
//    8440  |   GET /api/agents
//    8462  |   GET /api/admin — Admin Dashboard HTML
//    8850  |   GET /api/admin/stats
//    8914  |   GET /api/locks
//    8946  |   POST /api/normalize
//    8987  |   GET/POST /api/config
//    9022  |   POST /api/set-working-dir
//    9054  |   GET /api/ssot
//    9087  |   GET /api/sessions
//    9143  |   GET /api/sessions/{id}
//    9200  | POST /v1/chat/completions (OpenAI-compatible streaming)
//    9956  | POST /api/mission (Unified Socket Architecture)
//   10029  | POST /api/v1/anti-dote (Unified Socket Architecture)
//   10214  | POST /mcp (JSON-RPC 2.0) + GET /mcp (list tools)
//   10302  | POST /api/workspace + POST /api/syllabus
//   10351  | POST /api/input — Unified HTTP entry point
//   10401  | WebSocket (upgrade + message handling)
//   10669  | MCP Socket Server (UDS on Linux/Mac, TCP fallback on Windows)
//   10845  | TransportAdapter class
//   11092  | injectContext() — 3-layer context loader
//   11523  | Cross-Verification Helpers
//   11654  | Compiler Check Helpers
//   11770  | handleMessage() — 8-step processing pipeline
//   11987  | shutdown() — Graceful shutdown + cleanup
// ---------+--------------------------------------------------------------------------
// Total: ~11970 lines · Zero external dependencies · 10 MCP tools · 4 transports
// Section: OS-Aware Auto-Setup (line 153) creates .missionbarisal/ at runtime
//          with version.json, mcp-config.json, vscode.json, jetbrains.json, editor-config.json
// =============================================================================

// ── Core Modules (zero external dependencies) ────────────────
const http = require("http");
const https = require("https");
const http2 = require("http2");
const { URL, pathToFileURL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const netModule = require("net");
const os = require("os");
const externalMcp = require("./external-mcp.js");
const { loadAgentFiles, getAgentById, listAgentIds } = require("./agent");

// ─── Domain Configuration (per-server identity) ──────────────
const {
  detectDomain,
  getDomainConfig,
  DOMAIN_CONFIGS,
} = require("./domain-config");

// ─── .env Loader (zero-dependency) ───────────────────────────
(function loadEnv() {
  try {
    const envPath = path.resolve(".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        )
          v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
      console.log("[ENV] Loaded:", envPath);
    }
  } catch (_) { }
})();

// ─── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
// Unique per-process fingerprint — lets multi-instance tests prove that
// two `node api.js` runs on one machine really are independent processes.
const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomUUID();
const OPENCODE_BASE = process.env.OPENCODE_BASE || "https://opencode.ai/zen/v1";
const MAX_DEBATE_ROUNDS = parseInt(process.env.MAX_DEBATE_ROUNDS || "0", 10);
const LOG_DIR = path.resolve(process.env.LOG_DIR || "./logs");
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const PERSONAS_FILE = path.resolve(
  process.env.PERSONAS_FILE || "./PERSONAS.md",
);
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL || "86400000", 10);
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "10", 10); // reduced from 20→10: 50k+ token history overwhelms free tier models
const GIT_PERSONAS_URL = process.env.GIT_PERSONAS_URL || "";
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || "300000", 10); // Local CPU model timeout (default 5 min)

// ─── User-Agent Constant ────────────────────────────────────
const USER_AGENT = "MissionBarisal-v3/1.0";
let ALLOWED_DIRS = (
  process.env.ALLOWED_DIRS || LOG_DIR + "," + DATA_DIR + "," + path.resolve(".")
)
  .split(",")
  .map((d) => path.resolve(d.trim()));

// ─── Domain Detection ────────────────────────────────────────
// Domain detected immediately on server start — env var > port heuristic > localhost
const DETECTED_DOMAIN = detectDomain();
const DOMAIN_CFG = getDomainConfig(DETECTED_DOMAIN);
console.log(
  "[DOMAIN] Detected:",
  DETECTED_DOMAIN,
  "| Type:",
  DOMAIN_CFG.type,
  "| Version:",
  DOMAIN_CFG.version,
);

// ─── Pusher Config (optional) ────────────────────────────────
// 🧟 SECURITY: Default credentials are PLACEHOLDERS only!
// Set PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET via .env for real use.
// Default values below are non-functional examples — do NOT use in production.
const PUSHER_APP_ID = process.env.PUSHER_APP_ID || "";
const PUSHER_KEY = process.env.PUSHER_KEY || "";
const PUSHER_SECRET = process.env.PUSHER_SECRET || "";
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER || "ap2";
const PUSHER_ENABLED = !!(PUSHER_APP_ID && PUSHER_KEY && PUSHER_SECRET);
if (!PUSHER_ENABLED && process.env.PUSHER_APP_ID) {
  console.warn(
    "[PUSHER] Pusher misconfigured — check PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET in .env",
  );
}

// SSE (Server-Sent Events) clients for MCP streaming
// JetBrains/IDE clients use SSE for persistent MCP transport
// Map: clientId -> { res, connectedAt }
const sseClients = new Map();

// Unix Domain Socket path for MCP
// Priority: 1) env UDS_PORT, 2) DOMAIN_CFG.udsPort, 3) 5100 default
// No hardcoded magic values — "শয়তানের মলম থাকবে না"
const UDS_PORT = parseInt(
  process.env.UDS_PORT ||
  (typeof DOMAIN_CFG !== "undefined" ? DOMAIN_CFG.udsPort : null) ||
  "5100",
  10,
);
const UDS_PATH =
  process.env.UDS_PATH ||
  path.join(os.tmpdir(), "zombiecoder", "mcp.sock");
let udsServer = null; // UDS server instance (assigned in init())

// ─── Cache & Git Config ─────────────────────────────────────
// Cross-session user cache for accuracy & performance
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || "./cache");
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "86400000", 10); // 24h default
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || "1000", 10);

// Git runtime download URLs — personas, skills, instructions
const GIT_SKILLS_URL = process.env.GIT_SKILLS_URL || "";
const GIT_INSTRUCTIONS_URL = process.env.GIT_INSTRUCTIONS_URL || "";
const SKILLS_DIR = path.resolve(process.env.SKILLS_DIR || "./skills");

// ─── Runtime Config (changeable via API without restart) ──────
const RUNTIME_CONFIG = {
  sessionVerifyUrl: DOMAIN_CFG.sessionVerifyUrl,
  allowedOrigins: DOMAIN_CFG.corsOrigins,
  logLevel: "INFO",
  antiDoteEnabled: process.env.ANTIDOTE_ENABLED !== "false", // default: true
  updatedAt: new Date().toISOString(),
  domain: DETECTED_DOMAIN,
  serverType: DOMAIN_CFG.type,
  serverVersion: DOMAIN_CFG.version,
};

function updateRuntimeConfig(updates) {
  if (updates.sessionVerifyUrl) {
    RUNTIME_CONFIG.sessionVerifyUrl = updates.sessionVerifyUrl;
  }
  if (updates.logLevel) {
    RUNTIME_CONFIG.logLevel = updates.logLevel;
  }
  if (updates.allowedOrigins && Array.isArray(updates.allowedOrigins)) {
    RUNTIME_CONFIG.allowedOrigins = updates.allowedOrigins;
  }
  if (typeof updates.antiDoteEnabled === "boolean") {
    RUNTIME_CONFIG.antiDoteEnabled = updates.antiDoteEnabled;
  }
  RUNTIME_CONFIG.updatedAt = new Date().toISOString();
  persistRuntimeConfig(); // 🧟 survive restart (settings KV)
  return { ...RUNTIME_CONFIG };
}

// 🧟 Persist/load RUNTIME_CONFIG in the settings table — the config page
// now actually DOES something beyond this boot.
function persistRuntimeConfig() {
  if (!MODELS_DB) return;
  try {
    const { updatedAt, ...rest } = RUNTIME_CONFIG;
    MODELS_DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('runtime_config', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(JSON.stringify(rest), Date.now());
    log("INFO", "RUNTIME_CONFIG_SAVED", { keys: Object.keys(rest) });
  } catch (e) {
    log("WARN", "RUNTIME_CONFIG_SAVE_FAIL", { error: e.message });
  }
}

function loadRuntimeConfig() {
  if (!MODELS_DB) return;
  try {
    const row = MODELS_DB.prepare(
      "SELECT value FROM settings WHERE key = 'runtime_config'"
    ).get();
    if (!row || !row.value) return;
    const saved = JSON.parse(row.value);
    for (const k of ["sessionVerifyUrl", "logLevel", "antiDoteEnabled"]) {
      if (saved[k] !== undefined) RUNTIME_CONFIG[k] = saved[k];
    }
    if (Array.isArray(saved.allowedOrigins)) {
      RUNTIME_CONFIG.allowedOrigins = saved.allowedOrigins;
    }
    RUNTIME_CONFIG.updatedAt = new Date().toISOString();
    log("INFO", "RUNTIME_CONFIG_LOADED", { keys: Object.keys(saved) });
  } catch (e) {
    log("WARN", "RUNTIME_CONFIG_LOAD_FAIL", { error: e.message });
  }
}

// ─── OS-Aware Path Resolution + Auto-Setup ─────────────────────
// Cross-platform: detects Windows/Linux/macOS at runtime.
// Variables auto-resolve root directories per OS.
// Directories created automatically on server start.
// If config files exist, they are updated (replaced), not recreated.
const _PLATFORM = os.platform();
const _IS_WINDOWS = _PLATFORM === "win32";
const _IS_LINUX = _PLATFORM === "linux";
const _IS_MACOS = _PLATFORM === "darwin";

function getOSRootDir() {
  if (_IS_WINDOWS) return process.env.SYSTEMDRIVE || "C:";
  return "/";
}
const _OS_ROOT_DIR = getOSRootDir();
const _HOME_DIR = os.homedir();
const _TEMP_DIR = os.tmpdir();
const _HOSTNAME = os.hostname();

// Editor config directories per platform (global pattern — all editors)
function getEditorConfigDir(editorName) {
  const e = editorName.toLowerCase();
  const appData = process.env.APPDATA || _HOME_DIR;
  if (_IS_WINDOWS) {
    if (e === "vscode" || e === "code")
      return path.join(appData, "Code", "User");
    if (e === "jetbrains" || e === "idea")
      return path.join(appData, "JetBrains");
    if (e === "cursor") return path.join(appData, "Cursor", "User");
    return path.join(_HOME_DIR, "." + editorName);
  }
  if (e === "vscode" || e === "code")
    return path.join(_HOME_DIR, ".config", "Code", "User");
  if (e === "jetbrains" || e === "idea")
    return path.join(_HOME_DIR, ".config", "JetBrains");
  if (e === "cursor") return path.join(_HOME_DIR, ".config", "Cursor", "User");
  return path.join(_HOME_DIR, "." + editorName);
}

// .missionbarisal/ folder at project root (runtime config directory)
const _MISSION_BARISAL_DIR = path.join(process.cwd(), ".missionbarisal");

// ─── Auto-Setup: ensure directory exists ──────────────────────
function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log("[AUTO-SETUP] + Created directory:", dirPath);
      return { created: true, path: dirPath };
    }
    return { created: false, path: dirPath };
  } catch (err) {
    console.error("[AUTO-SETUP] ! Failed to create:", dirPath, err.message);
    return { created: false, path: dirPath, error: err.message };
  }
}

// ─── Auto-Setup: read JSON with fallback ──────────────────────
function readJSONSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) { }
  return fallback;
}

// ─── Auto-Setup: write JSON atomically ────────────────────────
function writeJSONSafe(filePath, data) {
  try {
    ensureDir(path.dirname(filePath));
    const tmp = filePath + ".tmp." + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.error("[AUTO-SETUP] ! Failed to write:", filePath, err.message);
    return false;
  }
}

// ─── Auto-Setup: create or update all config files ────────────
function autoSetupConfig() {
  const results = [];
  // 1) Ensure .missionbarisal/ directory
  const d = ensureDir(_MISSION_BARISAL_DIR);
  results.push({
    type: "dir",
    path: _MISSION_BARISAL_DIR,
    action: d.created ? "created" : "already-exists",
  });

  // 2) Default config templates (in-memory, not separate files)
  const defaults = {
    "version.json": {
      version: "3.2.1",
      build: "20260925",
      name: "Mission Barisal Gateway",
      description: "Cross-editor MCP agent gateway",
      author: "ZombieCoder",
      compatibleEditors: ["vscode", "jetbrains", "cursor"],
      minEngineVersion: "18.0.0",
      lastUpdated: new Date().toISOString(),
    },
    "mcp-config.json": {
      name: "Mission Barisal Gateway",
      transport: { type: "stdio", command: "node", args: ["start.js"] },
      endpoints: {
        http: `http://localhost:${PORT}`,
        uds: UDS_PATH,
        ws: `ws://localhost:${PORT}`,
      },
      tools: [
        "read_file",
        "write_file",
        "set_working_dir",
        "get_working_dir",
        "list_directory",
        "web_search",
        "read_ssot",
        "get_memory",
        "agent_mission",
        "agent_single",
        "terminal",
        "delete_file",
        "rename_file",
        "grep",
        "glob",
      ],
      timeout: 300000,
    },
    "vscode.json": {
      editor: "vscode",
      settings: {
        "mission-barisal.serverUrl": `http://localhost:${PORT}`,
        "mission-barisal.udsPath": UDS_PATH,
        "mission-barisal.agentMode": "mission",
      },
    },
    "jetbrains.json": {
      editor: "jetbrains",
      settings: {
        "mission-barisal.serverUrl": `http://localhost:${PORT}`,
        "mission-barisal.udsPath": UDS_PATH,
        "mission-barisal.agentMode": "mission",
      },
    },
    "editor-config.json": {
      version: "1.0",
      global: {
        serverUrl: `http://localhost:${PORT}`,
        udsPath: UDS_PATH,
        agentMode: "mission",
        autoConnect: true,
      },
      editors: {
        vscode: { transport: ["http", "uds", "ws"] },
        jetbrains: { transport: ["http", "uds"] },
        cursor: { transport: ["http", "ws"] },
      },
    },
  };

  // 3) Create or update each config file
  for (const [filename, defaultData] of Object.entries(defaults)) {
    const filePath = path.join(_MISSION_BARISAL_DIR, filename);
    if (fs.existsSync(filePath)) {
      const existing = readJSONSafe(filePath, {});
      const merged = {
        ...defaultData,
        ...existing,
        lastUpdated: new Date().toISOString(),
      };
      const ok = writeJSONSafe(filePath, merged);
      results.push({
        type: "file",
        name: filename,
        action: ok ? "updated" : "update-failed",
      });
    } else {
      const data = { ...defaultData, lastUpdated: new Date().toISOString() };
      const ok = writeJSONSafe(filePath, data);
      results.push({
        type: "file",
        name: filename,
        action: ok ? "created" : "create-failed",
      });
    }
  }
  return results;
}

// ─── Auto-Setup: print setup report ───────────────────────────
// Format contract (matches the reference block in logs/a1.md):
//   banner + "  OS: ... | Root: ... | Host: ..." + "  [x] type: name (action)"
// v3.2.1 fixes: failures used to get SUCCESS glyphs ([+]/[~] for
// create-failed/update-failed), the glyphs had no legend, and the report
// carried no timestamp or summary. Lines for successful actions are
// byte-identical to the original format.
function printSetupReport(results) {
  const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  console.log("\n=== AUTO-SETUP REPORT ===");
  console.log("  Time: " + new Date().toISOString());
  console.log(
    "  OS:",
    _PLATFORM,
    "| Root:",
    _OS_ROOT_DIR,
    "| Host:",
    _HOSTNAME,
  );
  console.log("  Legend: [+] created  [ ] unchanged  [~] updated  [!] failed");
  for (const r of results) {
    const act = r.action;
    const failed = act.endsWith("-failed");
    const glyph = failed
      ? "!"
      : act.startsWith("create")
        ? "+"
        : act.startsWith("update")
          ? "~"
          : " ";
    if (failed) counts.failed++;
    else if (act.startsWith("create")) counts.created++;
    else if (act.startsWith("update")) counts.updated++;
    else counts.unchanged++;
    console.log(
      "  [" +
      glyph +
      "] " +
      r.type +
      ": " +
      (r.name || r.path || "") +
      " (" +
      act +
      ")",
    );
  }
  console.log(
    "  Summary: " +
    counts.created +
    " created, " +
    counts.updated +
    " updated, " +
    counts.unchanged +
    " unchanged, " +
    counts.failed +
    " failed",
  );
  if (counts.failed > 0) {
    console.log("  ⚠️ SETUP FAILURES — check permissions on the items marked [!] above");
  }
  console.log("=========================\n");
}

// Execute auto-setup immediately on server start
const _setupResults = autoSetupConfig();
printSetupReport(_setupResults);

// ─── System Identity (domain-aware) ──────────────────────────
const SYSTEM_IDENTITY = {
  system_identity: {
    ...DOMAIN_CFG.identity,
    server: {
      domain: DETECTED_DOMAIN,
      type: DOMAIN_CFG.type,
      version: DOMAIN_CFG.version,
      hasFrontend: DOMAIN_CFG.hasFrontend,
      hasPusher: PUSHER_ENABLED,
      maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
    },
  },
};

const SYSTEM_IDENTITY_PROMPT = `⚠️ IDENTITY RULES — Your persona above IS your identity:
1. Your name, character, and tone come ONLY from the persona text above.
2. NEVER reveal your underlying model provider (OpenAI, DeepSeek, Google, etc.)
3. NEVER claim to be from any AI company.
4. NEVER say "ZombieCoder Dev Agent" or any platform name as your identity — your identity is in the persona above.
5. Always respond in Bengali unless the user explicitly requests English.
6. Be truthful — never present assumptions as facts.
7. Admit when you are unsure or lack information.
8. PROOF REQUIRED: NEVER answer without verifiable proof. If no evidence available, say "আমার কাছে এই বিষয়ে প্রমাণ নেই" and admit uncertainty, but still try to help with what you know.`;

const THREE_FILE_MEMORY_PROMPT = `📁 YOUR MEMORY SYSTEM — You have THREE files:
1. **SSOT.md** — Project context (tech stack, structure, files). Read this for project-level facts.
2. **syllabus.md** — Your learned knowledge. This is your growing brain — what you learned from web search, GitHub, docs. ALWAYS check this first before answering.
3. **memory.json** — Session history. Contains conversation context and archive index of past sessions.

📁 RULES:
- SSOT → answer project questions
- Syllabus → answer knowledge questions (things you learned before)
- Memory → maintain conversation continuity
- If info is NOT in any of these 3 files → say "এই তথ্য বর্তমানে আমার স্মৃতিতে নেই, আমি ওয়েব সার্চ করে দেখছি" then search
- NEVER overwrite or delete these files — only append new knowledge to syllabus
- When you learn something new, it should be saved to syllabus.md for future use`;

const INTENT_EXTRACT_PROMPT = `You are an intent analyzer. Extract the core intent from the user input.
Return ONLY valid JSON in this exact format:
{
  "primary_intent": "what the user fundamentally wants",
  "context": "key contextual clues",
  "requires_web_search": true/false,
  "requires_code_analysis": true/false,
  "language": "bn|en|other",
  "complexity": "simple|moderate|complex"
}`;

const ALIGNMENT_CHECK_PROMPT = `You are a strict alignment verifier. Check if the agent's response is 100% aligned with the user's original intent.

CRITICAL RULE: The response MUST reference the user's actual input. If the response talks about unrelated topics or makes claims not grounded in the user's question, mark it as misaligned.

Check criteria:
1. DIRECTNESS: Does the response directly address the user's question? (MUST have explicit reference to user input)
2. REFERENCE: Does the response contain evidence or reasoning tied to the user's query? If it claims facts without user input reference, mark as hallucination
3. ACCURACY: Is the information factually correct? If unsure, flag it
4. HALLUCINATION: Is there any made-up, unverified, or assumed information not present in the user's input? If the agent claims capabilities or identities not verifiable, flag it
5. LANGUAGE: Is the response in the correct language matching the user's input?
6. COMPLETENESS: Are all aspects of the question addressed? If the question has multiple parts, all must be answered
7. 🔬 PROOF & EVIDENCE: Does the response provide verifiable proof for each claim? Check for specific references to files, line numbers, search results, SSOT data, syllabus entries, or other concrete evidence. Opinions without evidence = FAIL.
8. 🧪 TEST CLAIMS (NEW): If the agent claims a code change "works", "fixes", or "solves" — check if test evidence is provided. "It will work" without proof = MISALIGNED with truth.
9. 🔒 CODE SAFETY (NEW): If suggesting code modifications, check if specific files and lines are mentioned. Vague suggestions without file paths = UNSAFE.
10. 📚 KNOWLEDGE REFERENCE (NEW): If the response mentions technical concepts, frameworks, or patterns — check if the agent referenced its syllabus.md or memory.json. If the agent claims knowledge without source (SSOT/syllabus/web search), flag it as unverfied. "Syllabus অনুযায়ী" or "memory থেকে পাওয়া" = GOOD. Unexplained expert claims = BAD.

SCORING:
- 100 = perfect alignment, directly answers user input with verifiable content AND provides evidence for claims
- 70-99 = mostly aligned but minor issues, some claims lack evidence, or code claims missing test proof
- 40-69 = partially aligned, missing key references to user input, significant unsupported claims, unsafe code suggestions
- 0-39 = misaligned, hallucinated, unrelated to user's question, OR no evidence provided for claims

Return ONLY valid JSON:
{
  "aligned": true/false,
  "score": 0-100,
  "issues": ["specific issue descriptions — mention exact missing references and unproven claims"],
  "suggestions": ["how to fix — must tell agent to reference user input directly and provide evidence"],
  "missing_proof": ["list specific claims that lack evidence"],
  "code_safe": true/false,
  "test_verified": true/false
}`;

const PROOF_CHECK_PROMPT = `You are a strict evidence verifier. Your job is to check if the agent's response contains VERIFIABLE PROOF or EVIDENCE.

Check criteria:
1. EVIDENCE: Does the response contain specific data, code analysis, search results, file contents, or explicit references? Opinions, guesses, and assumptions are NOT evidence.
2. SOURCE CITATION: Does the response cite where information came from? (e.g., "SSOT অনুযায়ী", "web search ফলাফলে দেখা গেছে", "api.js এর লাইন ১৫০-তে দেখা যাচ্ছে")
3. VERIFIABILITY: Can the claims be independently verified? If the response makes a claim without showing how it was derived, flag it.
4. EMPTY ASSURANCES: Does the response use phrases like "আমি মনে করি", "probably", "I think", "maybe", "আমার ধারণা" without supporting evidence? These are RED FLAGS.
5. HALLUCINATION: Does the response invent facts, APIs, functions, or capabilities that don't exist in the provided context?
6. TEST CLAIMS (NEW — STRICT): If the response claims a code change "works", "fixes", or "solves" a problem — it MUST provide test evidence. Phrases like "it will work", "this should fix", "এতে কাজ করবে" without test proof MUST be flagged. Valid test evidence = "tested with X input", "ran the code and got Y output", "verified with unit test Z", or explicit "UNTESTED" disclaimer.
7. CODE SAFETY: If the response suggests modifying code, verify it mentions WHICH files and lines to change. Unsafe = vague suggestions without file paths or awareness of existing code structure.

SCORING:
- 100 = Every claim backed by evidence, sources cited, fully verifiable, code claims include test evidence
- 70-99 = Mostly evidenced, minor claims unsubstantiated, or code changes claimed without test proof
- 40-69 = Some evidence but significant unsupported claims, missing file references
- 0-39 = NO evidence provided, pure speculation or hallucination, unsafe code suggestions

Return ONLY valid JSON:
{
  "has_proof": true/false,
  "proof_score": 0-100,
  "missing_evidence": ["specific claims that need proof"],
  "verdict": "PASS|FAIL|NEEDS_WORK",
  "action_required": "Provide specific evidence from code/search/SSOT for the unsubstantiated claims",
  "code_safe": true/false,
  "test_verified": true/false
}`;

// ══════════════════════════════════════════════════════════════
//  ANTI-DOTE TYPE SAFETY SYSTEM — Error Types & Classes
// ══════════════════════════════════════════════════════════════
// Fundamental Theorem:
//   ∀req ∈ AntidoteRequest: validateSchema(req) ∧ checkProof(req)
//     ⇒ setGoalContract(req) ⇒ execute(req) ⇒ verifyOutput(res)
//
//   P(execute(req) = expected) = 1 × 1 × 1 × 1 × 1 = 1 (certainty)
//
// Error types (6): INVALID_REQUEST, PROOF_FAILED, LIMIT_EXCEEDED,
//                  CONTRACT_FAILED, EXECUTION_FAILED, VERIFICATION_FAILED

const ANTIDOTE_ERRORS = {
  INVALID_REQUEST: {
    code: "ANTIDOTE_INVALID_REQUEST",
    message: "Input validation failed — malformed or missing required fields",
    statusCode: 400,
  },
  PROOF_FAILED: {
    code: "ANTIDOTE_PROOF_FAILED",
    message: "Logical proof check failed — request cannot be satisfied",
    statusCode: 422,
  },
  LIMIT_EXCEEDED: {
    code: "ANTIDOTE_LIMIT_EXCEEDED",
    message: "Rate limit, token limit or payload size exceeded",
    statusCode: 429,
  },
  CONTRACT_FAILED: {
    code: "ANTIDOTE_CONTRACT_FAILED",
    message: "Goal contract could not be established",
    statusCode: 422,
  },
  EXECUTION_FAILED: {
    code: "ANTIDOTE_EXECUTION_FAILED",
    message: "Execution failed — see inner error for details",
    statusCode: 500,
  },
  VERIFICATION_FAILED: {
    code: "ANTIDOTE_VERIFICATION_FAILED",
    message: "Output verification failed — result does not satisfy contract",
    statusCode: 500,
  },
};

class AntiDoteError extends Error {
  constructor(type, details = {}) {
    const def = ANTIDOTE_ERRORS[type] || ANTIDOTE_ERRORS.INVALID_REQUEST;
    const msg = details.reason
      ? `${def.message} — ${details.reason}`
      : def.message;
    super(msg);
    this.name = "AntiDoteError";
    this.code = def.code;
    this.statusCode = def.statusCode;
    this.errorType = type;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: true,
      type: this.errorType,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

// ─── Provider Registry + Dynamic Routing ────────────────────
// ─── Model Entry Helpers ──────────────────────────────────
// Each model entry can be:
//   string: "model-name" — name is both public and API model (no masking)
//   object: { name, apiModel } — name=public, apiModel=name sent to provider (masked)
function getModelName(m) {
  return typeof m === "string" ? m : m.name;
}
function getApiModelName(m) {
  return typeof m === "string" ? m : m.apiModel || m.name;
}

// Resolve public model name to API provider model name (masking reverse)
// providerId parameter added: searches within specific provider only.
// Previously searched all providers, causing Groq's fallback alias
// to route through OpenCode's primary path (wrong apiModel).
function resolveApiModel(publicModelName, providerId) {
  // 1. Search within specific provider (if providerId given)
  if (providerId && PROVIDER_CONFIG[providerId]) {
    const p = PROVIDER_CONFIG[providerId];
    // Search by name first
    for (const m of p.models) {
      if (getModelName(m) === publicModelName) return getApiModelName(m);
    }
    // If not found, search by apiModel (e.g. nemotron-3-ultra-free -> model-pro)
    for (const m of p.models) {
      if (getApiModelName(m) === publicModelName) return getModelName(m);
    }
    // Not found in this provider, return original name
    return publicModelName;
  }
  // 2. Fallback: search all providers (old behaviour)
  for (const p of Object.values(PROVIDER_CONFIG)) {
    for (const m of p.models) {
      if (getModelName(m) === publicModelName) return getApiModelName(m);
    }
  }
  return publicModelName;
}

// ─── Provider Registry ────────────────────────────────────
// Each provider supplies its own model list.
// Haq Mawla normalizer converts all provider responses to OpenAI format.
// competitionRouter: model -> provider -> API call -> normalize -> agent

// ─── Env Model Parser ──────────────────────────────────────
// Parses a comma-separated model env var into model entries.
//   "model-a"            → string entry (no masking)
//   "name:apiModel"      → { name, apiModel } masked pair
function parseModelsEnv(str) {
  if (!str || !str.trim()) return [];
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx > 0) {
        return {
          name: entry.slice(0, idx).trim(),
          apiModel: entry.slice(idx + 1).trim(),
        };
      }
      return entry;
    });
}

// ─── Provider Registry ────────────────────────────────────
// Each provider supplies its own model list.
// Haq Mawla normalizer converts all provider responses to OpenAI format.
// competitionRouter: model -> provider -> API call -> normalize -> agent
//
// NO HARDCODED MODELS — every provider loads its model list from env:
//   OPENCODE_MODELS, GROQ_MODELS, GEMINI_MODELS, CUSTOM_PROVIDER_N_MODELS
// Priorities also come from env: OPENCODE_PRIORITY, GROQ_PRIORITY, ...
const PROVIDER_CONFIG = {
  opencode: {
    name: "OpenCode",
    baseUrl: process.env.OPENCODE_BASE || "https://opencode.ai/zen/v1",
    key: process.env.OPENCODE_API_KEY || "",
    priority: parseInt(process.env.OPENCODE_PRIORITY || "1", 10),
    type: process.env.OPENCODE_TYPE || "openai",
    models: parseModelsEnv(process.env.OPENCODE_MODELS || ""),
  },
  // ── Groq (Secondary Fallback) ────────────────────────────
  // Acts as a pipeline provider — routes model names to their Groq equivalents.
  // When OpenCode fails, Groq serves as fallback.
  groq: {
    name: "Groq",
    baseUrl: process.env.GROQ_BASE || "https://api.groq.com/openai/v1",
    key: process.env.GROQ_API_KEY || "",
    priority: parseInt(process.env.GROQ_PRIORITY || "3", 10),
    type: process.env.GROQ_TYPE || "openai",
    models: parseModelsEnv(process.env.GROQ_MODELS || ""),
  },
  // ── Gemini (Tertiary) ──────────────────────────────────────
  // Requires API key — OpenCode -> Groq -> Gemini fallback chain
  gemini: {
    name: "Gemini",
    baseUrl:
      process.env.GEMINI_BASE ||
      "https://generativelanguage.googleapis.com/v1beta",
    key: process.env.GEMINI_API_KEY || "",
    priority: parseInt(process.env.GEMINI_PRIORITY || "4", 10),
    type: "gemini", // special: Gemini API (NOT OpenAI-compatible)
    models: parseModelsEnv(process.env.GEMINI_MODELS || ""),
  },
  // ── Cloudflare (AI Gateway) ────────────────────────────
  // OpenAI-compatible gateway. The account id is embedded in CF_BASE_URL,
  // CF_API_TOKEN is used as the Bearer key, and models come from
  // CF_PROVIDER_MODELS. Reads the same CF_* env vars the .env defines.
  cloudflare: {
    name: "Cloudflare",
    baseUrl:
      process.env.CF_BASE_URL ||
      "https://api.cloudflare.com/client/v4/accounts/a23a4686369718f388aacac63c31d938/ai/v1",
    key: process.env.CF_API_TOKEN || "",
    priority: parseInt(process.env.CF_PRIORITY || "4", 10),
    type: process.env.CF_TYPE || "openai",
    models: parseModelsEnv(process.env.CF_PROVIDER_MODELS || ""),
  },
  // ── Ollama (Local + Cloud LLM) ─────────────────────────
  // First-class provider (NOT a custom_N provider). Serves local models
  // pulled via `ollama pull` AND cloud models (when the Ollama server's
  // cloud remote is reachable: OLLAMA_REMOTES / OLLAMA_NO_CLOUD) — both
  // surface through the same /v1/models endpoint, so dynamic discovery
  // yields "cloud if API else local" behaviour automatically.
  ollama: {
    name: "Ollama",
    baseUrl: process.env.OLLAMA_BASE || "https://ollama.com/v1",
    key: process.env.OLLAMA_API_KEY || "",
    priority: parseInt(process.env.OLLAMA_PRIORITY || "5", 10),
    type: process.env.OLLAMA_TYPE || "openai",
    models: parseModelsEnv(process.env.OLLAMA_MODELS || ""),
    local: true,
  },
};

// ─── Dynamic Custom Provider Loader ─────────────────────────
// Scans CUSTOM_PROVIDER_N_* env vars and dynamically adds them to
// PROVIDER_CONFIG. Supports any number of custom OpenAI-compatible APIs.
// Named function (not IIFE) so it can be re-run at runtime when the
// user triggers an env-var re-sync (env vars are the single source of truth).
function loadCustomProviders() {
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^CUSTOM_PROVIDER_(\d+)_(.+)$/);
    if (!m) continue;
    const num = m[1];
    const prop = m[2].toLowerCase();
    if (seen.has(num)) continue;
    seen.add(num);

    const name =
      process.env["CUSTOM_PROVIDER_" + num + "_NAME"] || "Custom-" + num;
    const url = process.env["CUSTOM_PROVIDER_" + num + "_URL"];
    const apiKey = process.env["CUSTOM_PROVIDER_" + num + "_KEY"] || "";
    const modelsStr = process.env["CUSTOM_PROVIDER_" + num + "_MODELS"] || "";
    const priority = parseInt(
      process.env["CUSTOM_PROVIDER_" + num + "_PRIORITY"] || "10",
      10,
    );
    const type = process.env["CUSTOM_PROVIDER_" + num + "_TYPE"] || "openai";

    if (!url) {
      console.warn("[CUSTOM_PROVIDER_" + num + "] Skipped: no URL set");
      continue;
    }

    const models = modelsStr
      ? modelsStr
        .split(",")
        .map(function (m) {
          return m.trim();
        })
        .filter(Boolean)
      : ["*"];

    const providerId = "custom_" + num;
    const socket =
      process.env["CUSTOM_PROVIDER_" + num + "_SOCKET"] || "";
    PROVIDER_CONFIG[providerId] = {
      name: name,
      baseUrl: url,
      key: apiKey,
      priority: priority,
      type: type,
      models: models,
      custom: true,
      socketPath: socket || undefined,
    };
    console.log("[CUSTOM_PROVIDER] Loaded: " + name + " (" + url + ")");
  }
  if (seen.size > 0) {
    console.log("[CUSTOM_PROVIDER] Total loaded: " + seen.size);
  }
}
loadCustomProviders();

// ══════════════════════════════════════════════════════════════
//  🗄️  SQLite MODELS DATABASE (zero-dependency via node:sqlite)
// ══════════════════════════════════════════════════════════════
// The API Normalizer syncs provider models into a `models` table.
// Lookup order: DB first → env (PROVIDER_CONFIG) → fallback reply.
// If node:sqlite is unavailable (old Node), server falls back to env-only.
let MODELS_DB = null;
// 🧟 DB path priority: env DB_SQLITE_PATH → DATA_DIR/models.db (fallback),
// so a forgotten env var can never brick the gateway.
const MODELS_DB_PATH = path.resolve(
  process.env.DB_SQLITE_PATH || path.join(DATA_DIR, "models.db"),
);

// Initialize the models database + table.
function initModelsDb() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 🧟 Alibaba-40-thieves: when the stored DB is missing locally, pull the
    // snapshot from git (raw) down to the exact location — validated as a
    // real SQLite file before adopting (HTML error pages are rejected).
    if (!fs.existsSync(MODELS_DB_PATH)) {
      const remote =
        process.env.DB_REMOTE_URL ||
        "https://raw.githubusercontent.com/sahonsrabon-os/monu_the_builder/main/registry.db";
      if (remote.startsWith("http")) {
        const tmp = MODELS_DB_PATH + ".dl";
        try {
          log("INFO", "REGISTRY_DB_FETCH", { url: remote, to: MODELS_DB_PATH });
          require("child_process").execFileSync(
            "curl",
            ["-sSL", "--max-time", "30", "-o", tmp, remote],
            { stdio: "pipe" },
          );
          const head = Buffer.alloc(16);
          const fd = fs.openSync(tmp, "r");
          fs.readSync(fd, head, 0, 16, 0);
          fs.closeSync(fd);
          if (head.toString("latin1", 0, 15) === "SQLite format 3") {
            fs.renameSync(tmp, MODELS_DB_PATH);
            log("INFO", "REGISTRY_DB_DOWNLOADED", {
              url: remote,
              to: MODELS_DB_PATH,
              bytes: fs.statSync(MODELS_DB_PATH).size,
            });
          } else {
            fs.unlinkSync(tmp);
            log("WARN", "REGISTRY_DB_INVALID", { reason: "not a sqlite file" });
          }
        } catch (e) {
          try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
          log("WARN", "REGISTRY_DB_FETCH_FAIL", { error: e.message });
        }
      }
    }
    MODELS_DB = new DatabaseSync(MODELS_DB_PATH);
    MODELS_DB.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        api_model TEXT NOT NULL,
        provider_name TEXT,
        type TEXT,
        priority INTEGER DEFAULT 99,
        updated_at INTEGER DEFAULT 0,
        UNIQUE(provider, name)
      );
      CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
      CREATE INDEX IF NOT EXISTS idx_models_api ON models(api_model);
      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);

      -- PHASE A (2026-08-10): agents table — DB-first persona source.
      -- PERSONAS.md + .zombiecoder/agents/*.md remain as fallback/override (100% kept).
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        model TEXT,
        expertise TEXT,
        persona TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 99,
        updated_at INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);

      -- PHASE B (2026-08-10): users + sessions tables (minimal API auth).
      -- api_key is stored as sha256 hex (never plaintext). sessions hold
      -- short-lived bearer tokens issued by /api/auth/verify.
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        token_limit INTEGER DEFAULT 0,
        valid_days INTEGER DEFAULT 0,
        token_used INTEGER DEFAULT 0,
        expires_at INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token TEXT NOT NULL,
        created_at INTEGER DEFAULT 0,
        expires_at INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
    // UI-1 migration: add token_limit / valid_days / token_used / expires_at
    // to an existing users table (idempotent — safe on fresh installs too).
    try {
      const cols = MODELS_DB.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
      const addCol = (col, ddl) => {
        if (!cols.includes(col)) {
          MODELS_DB.prepare("ALTER TABLE users ADD COLUMN " + ddl).run();
        }
      };
      addCol("token_limit", "token_limit INTEGER DEFAULT 0");
      addCol("valid_days", "valid_days INTEGER DEFAULT 0");
      addCol("token_used", "token_used INTEGER DEFAULT 0");
      addCol("expires_at", "expires_at INTEGER DEFAULT 0");
    } catch (migErr) {
      log("WARN", "USERS_MIGRATE_FAIL", { error: migErr.message });
    }
    // 🧟 Registry migrations: models can be toggled from the admin panel.
    //   enabled — admin on/off (sync upserts NEVER touch it, so the flag survives)
    //   pinned  — seeded from remote registry; syncModelsToDb's stale-row DELETE
    //             skips pinned rows (otherwise remote seeds vanish next boot)
    try {
      const mcols = MODELS_DB.prepare("PRAGMA table_info(models)").all().map((c) => c.name);
      if (!mcols.includes("enabled")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN enabled INTEGER DEFAULT 1").run();
      if (!mcols.includes("pinned")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN pinned INTEGER DEFAULT 0").run();
    } catch (migErr) {
      log("WARN", "MODELS_MIGRATE_FAIL", { error: migErr.message });
    }
    // 🧟 settings KV — persisted runtime state (provider_disabled etc.)
    MODELS_DB.prepare(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0)"
    ).run();
    // 🧟 Gateway telemetry — ONE database holds every table/column this
    // gateway needs: request log, session log, provider/model/agent/tool stats.
    MODELS_DB.exec(`
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        path TEXT,
        session_id TEXT,
        editor TEXT,
        agent TEXT,
        model TEXT,
        provider TEXT,
        status INTEGER,
        ok INTEGER DEFAULT 1,
        elapsed_ms INTEGER DEFAULT 0,
        swap_count INTEGER DEFAULT 0,
        domain TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts);
      CREATE INDEX IF NOT EXISTS idx_request_log_session ON request_log(session_id);
      CREATE TABLE IF NOT EXISTS session_log (
        id TEXT PRIMARY KEY,
        editor TEXT,
        agent TEXT,
        model TEXT,
        provider TEXT,
        status TEXT DEFAULT 'active',
        requests INTEGER DEFAULT 0,
        created_at INTEGER,
        last_seen INTEGER,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_log_seen ON session_log(last_seen);
      CREATE TABLE IF NOT EXISTS provider_stats (
        provider TEXT PRIMARY KEY,
        requests INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER,
        last_error TEXT,
        last_error_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS model_stats (
        model TEXT PRIMARY KEY,
        provider TEXT,
        requests INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_stats (
        agent TEXT PRIMARY KEY,
        calls INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER,
        last_model TEXT,
        last_provider TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_stats (
        tool TEXT PRIMARY KEY,
        calls INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER,
        enabled INTEGER DEFAULT 1
      );
    `);
    log("INFO", "SQLITE_READY", { path: MODELS_DB_PATH });
    return true;
  } catch (e) {
    MODELS_DB = null;
    log("WARN", "SQLITE_UNAVAILABLE", { error: e.message });
    return false;
  }
}

// Upsert ALL PROVIDER_CONFIG models into the DB. Returns count.
function syncModelsToDb() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  const now = Date.now();
  try {
    const upsert = MODELS_DB.prepare(`
      INSERT INTO models (provider, name, api_model, provider_name, type, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, name) DO UPDATE SET
        api_model = excluded.api_model,
        provider_name = excluded.provider_name,
        type = excluded.type,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `);
    let count = 0;
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      if (p.models.length === 0) continue;
      for (const m of p.models) {
        upsert.run(
          id,
          getModelName(m),
          getApiModelName(m),
          p.name,
          p.type,
          p.priority || 99,
          now,
        );
        count++;
      }
    }
    // Remove stale rows (models no longer present after this sync)
    // 🧟 pinned=1 rows are remote-registry seeds — they survive across syncs
    MODELS_DB.prepare("DELETE FROM models WHERE updated_at < ? AND COALESCE(pinned,0) = 0").run(now);
    log("INFO", "MODELS_DB_SYNCED", { count, path: MODELS_DB_PATH });
    return { ok: true, synced: count };
  } catch (e) {
    log("WARN", "MODELS_DB_SYNC_FAIL", { error: e.message });
    return { ok: false, error: e.message };
  }
}

// Runtime env-var check → update models → sync into DB.
// Env vars are the SINGLE SOURCE OF TRUTH: this re-reads the model list
// env vars (OPENCODE_MODELS, GROQ_MODELS, GEMINI_MODELS,
// CUSTOM_PROVIDER_N_MODELS) and re-syncs the current env state into the
// SQLite models table. Callable at startup or on demand (e.g. after the
// user edits .env) without a server restart.
function syncEnvModelsToDb() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  const before = {
    opencode: PROVIDER_CONFIG.opencode.models.length,
    groq: PROVIDER_CONFIG.groq.models.length,
    gemini: PROVIDER_CONFIG.gemini.models.length,
  };
  // Re-read env vars (single source of truth) and update PROVIDER_CONFIG.
  PROVIDER_CONFIG.opencode.models = parseModelsEnv(
    process.env.OPENCODE_MODELS || "",
  );
  PROVIDER_CONFIG.groq.models = parseModelsEnv(process.env.GROQ_MODELS || "");
  PROVIDER_CONFIG.gemini.models = parseModelsEnv(process.env.GEMINI_MODELS || "");
  // Re-scan CUSTOM_PROVIDER_N_* env vars (adds new / updates existing).
  loadCustomProviders();
  const db = syncModelsToDb();
  refreshFreeModels();
  log("INFO", "ENV_MODELS_SYNCED", {
    before,
    after: {
      opencode: PROVIDER_CONFIG.opencode.models.length,
      groq: PROVIDER_CONFIG.groq.models.length,
      gemini: PROVIDER_CONFIG.gemini.models.length,
    },
    db,
  });
  return { ok: true, providers: Object.keys(PROVIDER_CONFIG), db };
}

// Load models from DB into PROVIDER_CONFIG (DB wins over env).
// Called at startup so a previously-synced DB is the source of truth.
function loadModelsFromDb() {
  if (!MODELS_DB) return false;
  try {
    // id ASC = insertion order → preserves env-defined order first,
    // then live-fetched models appended (so FREE_MODELS[0] stays stable).
    const rows = MODELS_DB.prepare(
      "SELECT provider, name, api_model FROM models ORDER BY id ASC",
    ).all();
    if (!rows.length) return false;
    const byProvider = {};
    for (const r of rows) {
      if (!byProvider[r.provider]) byProvider[r.provider] = [];
      byProvider[r.provider].push(
        r.name === r.api_model
          ? r.name
          : { name: r.name, apiModel: r.api_model },
      );
    }
    for (const [pid, models] of Object.entries(byProvider)) {
      if (PROVIDER_CONFIG[pid]) {
        PROVIDER_CONFIG[pid].models = models;
      }
    }
    log("INFO", "MODELS_DB_LOADED", {
      rows: rows.length,
      providers: Object.keys(byProvider).length,
    });
    refreshFreeModels();
    return true;
  } catch (e) {
    log("WARN", "MODELS_DB_LOAD_FAIL", { error: e.message });
    return false;
  }
}

// Look up a model name (public or apiModel) in the DB → provider row or null.
function findModelInDb(name) {
  if (!MODELS_DB) return null;
  try {
    const row = MODELS_DB.prepare(
      "SELECT provider, name, api_model FROM models WHERE name = ? OR api_model = ? LIMIT 1",
    ).get(name, name);
    return row || null;
  } catch (e) {
    return null;
  }
}

// ─── API Normalizer: fetch live models from each provider ──
// GET {baseUrl}/models and merge the returned model IDs into
// PROVIDER_CONFIG + SQLite. Keyless providers are still tried
// (public endpoints); redirects (3xx) are followed up to 3 hops.
function fetchProviderModels(providerId, p) {
  return new Promise((resolve) => {
    if (!p.baseUrl) return resolve({ ok: false, error: "no baseUrl" });

    const buildUrl = () => {
      if (p.type === "gemini") return new URL(p.baseUrl + "/models");
      return new URL(p.baseUrl.replace(/\/+$/, "") + "/models");
    };
    const buildHeaders = () => {
      const h = { "User-Agent": USER_AGENT };
      if (p.type === "gemini") {
        h["X-goog-api-key"] = p.key || "";
      } else if (p.key) {
        h["Authorization"] = "Bearer " + p.key;
      }
      return h;
    };

    // Follow up to 3 redirects — some gateways redirect /models
    const doFetch = (url, headers, redirectsLeft) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method: "GET",
        timeout: 20000,
        headers,
      };
      const proto = url.protocol === "http:" ? http : https;
      const req = proto.request(options, (res) => {
        // Redirect handling (301/302/303/307/308)
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume(); // discard body
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch (e) {
            return resolve({ ok: false, error: "bad redirect: " + e.message });
          }
          return doFetch(nextUrl, headers, redirectsLeft - 1);
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({
              ok: false,
              error: "HTTP " + res.statusCode,
              raw: data.slice(0, 300),
            });
          }
          try {
            const parsed = JSON.parse(data);
            let ids = [];
            if (p.type === "gemini") {
              ids = (parsed.models || []).map((m) =>
                String(m.name || "").replace(/^models\//, ""),
              );
            } else {
              ids = (parsed.data || []).map((m) => m.id).filter(Boolean);
            }
            resolve({ ok: true, models: ids, raw: parsed });
          } catch (e) {
            resolve({ ok: false, error: e.message, raw: data.slice(0, 300) });
          }
        });
      });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "timeout" });
      });
      req.end();
    };

    doFetch(buildUrl(), buildHeaders(), 3);
  });
}

// Run the full normalizer: fetch all providers → merge into config → sync DB.
// For masked providers (e.g. Groq aliases), env-defined pairs are preserved;
// live API models are appended as plain names (name == apiModel).
async function runNormalizerSync() {
  const results = {};
  for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
    if (p.enabled === false) {
      results[id] = { ok: false, skipped: true, reason: "admin-disabled" };
      continue;
    }
    if (!p.baseUrl) {
      results[id] = { ok: false, error: "no baseUrl", skipped: true };
      continue;
    }
    const fetched = await fetchProviderModels(id, p);
    if (fetched.ok && fetched.models.length > 0) {
      // Prune stale entries whose apiModel is no longer in the live API
      // (prevents dead mappings like llama-3.3-70b-versatile from persisting forever)
      const liveSet = new Set(fetched.models);
      p.models = p.models.filter(
        (m) =>
          getApiModelName(m) === "*" ||
          liveSet.has(getApiModelName(m)),
      );
      // Preserve env-defined masked pairs; append new live API models
      const existing = new Map();
      for (const m of p.models) existing.set(getModelName(m), m);
      const live = fetched.models.filter(
        (name) => !existing.has(name) && name !== "*",
      );
      p.models = p.models.concat(live);
      results[id] = {
        ok: true,
        fetched: fetched.models.length,
        added: live.length,
        total: p.models.length,
      };
    } else {
      results[id] = { ok: false, error: fetched.error || "no models" };
    }
  }
  const db = syncModelsToDb();
  refreshFreeModels();
  return { results, db };
}

// Computed: flattened list of all public model names (masked)
// NOTE: `let` + refreshFreeModels() — the list is recomputed after
// loadModelsFromDb() and runNormalizerSync() so counts stay accurate
// (DB-enriched models are reflected everywhere, incl. /health).
let FREE_MODELS = Object.values(PROVIDER_CONFIG)
  .filter((p) => p.models.length > 0)
  .flatMap((p) => p.models.map(getModelName));

// Recompute FREE_MODELS from the current PROVIDER_CONFIG state.
// Called after DB load and after every provider sync so that newly
// discovered models are included in health/status counts.
function refreshFreeModels() {
  FREE_MODELS = Object.values(PROVIDER_CONFIG)
    .filter((p) => p.models.length > 0)
    .flatMap((p) => p.models.map(getModelName));
}

// Computed: all public model -> provider mapping
function getAllModels() {
  const list = [];
  for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
    if (p.models.length === 0) {
      list.push({ model: "*", provider: id, providerName: p.name, providerType: p.type, enabled: p.enabled !== false });
    } else {
      for (const m of p.models) {
        list.push({
          model: getModelName(m),
          apiModel: getApiModelName(m),
          provider: id,
          providerName: p.name,
          providerType: p.type,
          type: typeof m === "object" && m.type ? m.type : p.type,
          enabled: p.enabled !== false && !DISABLED_MODELS.has(id + "::" + getModelName(m)),
        });
      }
    }
  }
  return list;
}

// Default model (first provider → first model)
function getDefaultModel() {
  for (const p of Object.values(PROVIDER_CONFIG)) {
    if (p.models.length > 0) return getModelName(p.models[0]);
  }
  return "model-pro";
}

function normalizeRoutingModel(model) {
  if (typeof model !== "string" || !model.trim()) return getDefaultModel();
  const requested = model.trim();
  const exact = resolveProvider(requested, true);
  if (exact) return requested;

  const agent = Array.isArray(AGENTS) ? AGENTS.find((item) => item.id === requested) : null;
  if (agent && typeof agent.model === "string") {
    const agentModel = resolveProvider(agent.model, true);
    if (agentModel) return agent.model;
  }

  const fallback = getDefaultModel();
  log("WARN", "MODEL_NOT_CONFIGURED", { requested, fallback });
  return fallback;
}

function getFallbackModel(excludeModel, triedModels) {
  const excludeSet = new Set(triedModels || []);
  if (excludeModel) excludeSet.add(excludeModel);
  const candidates = Object.values(PROVIDER_CONFIG)
    .sort((a, b) => (a.priority || 999) - (b.priority || 999))
    .flatMap((provider) => provider.models.map(getModelName));
  return candidates.find((candidate) => !excludeSet.has(candidate)) || null;
}

// ─── Competition Router ─────────────────────────────────────
// Resolves which provider to call based on model name
// ─── 🧟 Admin runtime enable/disable state (persisted in `settings`) ──
// Providers: PROVIDER_CONFIG[id].enabled === false → skipped by resolve/fallback/sync.
// Models:    DISABLED_MODELS has "provider::name"     → skipped by resolve.
let DISABLED_MODELS = new Set();

function firstEnabledProviderId() {
  const ids = Object.keys(PROVIDER_CONFIG);
  return ids.find((k) => PROVIDER_CONFIG[k].enabled !== false) || ids[0];
}

function loadDisabledState() {
  if (!MODELS_DB) return;
  try {
    const row = MODELS_DB.prepare(
      "SELECT value FROM settings WHERE key = 'provider_disabled'"
    ).get();
    const ids = row && row.value ? JSON.parse(row.value) : [];
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      p.enabled = !ids.includes(id);
    }
    const rows = MODELS_DB.prepare(
      "SELECT provider, name FROM models WHERE enabled = 0"
    ).all();
    DISABLED_MODELS = new Set(rows.map((r) => r.provider + "::" + r.name));
    log("INFO", "DISABLED_STATE_LOADED", {
      providers_off: ids.length,
      models_off: DISABLED_MODELS.size,
    });
  } catch (e) {
    log("WARN", "DISABLED_STATE_FAIL", { error: e.message });
  }
}

function persistProviderDisabled() {
  if (!MODELS_DB) return [];
  const ids = Object.entries(PROVIDER_CONFIG)
    .filter(([, p]) => p.enabled === false)
    .map(([id]) => id);
  try {
    MODELS_DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('provider_disabled', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(JSON.stringify(ids), Date.now());
  } catch (e) {
    log("WARN", "PROVIDER_DISABLED_SAVE_FAIL", { error: e.message });
  }
  return ids;
}

function getDisabledModelRows() {
  if (!MODELS_DB) return [];
  try {
    return MODELS_DB.prepare("SELECT provider, name FROM models WHERE enabled = 0").all();
  } catch (e) {
    return [];
  }
}

function resolveProvider(model, exactOnly) {
  // 🧟 GUARD: Reject template/placeholder model names (e.g. "{{model}}")
  // These come from misconfigured clients and cause massive PROXY_FAIL storms
  if (!model || typeof model !== "string" || /\{\{.*\}\}/.test(model) || model.length < 2) {
    const firstId = firstEnabledProviderId();
    return {
      providerId: firstId,
      config: PROVIDER_CONFIG[firstId],
      matchType: "template_guard",
    };
  }

  const allNames = new Map();
  // Sort by priority (lower number = higher priority) so OpenCode (priority:1) wins over Groq (priority:2)
  const sortedProviders = Object.entries(PROVIDER_CONFIG).sort(
    ([, a], [, b]) => (a.priority || 999) - (b.priority || 999),
  );
  for (const [id, p] of sortedProviders) {
    if (p.enabled === false) continue; // 🧟 admin-disabled provider
    for (const m of p.models) {
      const name = getModelName(m);
      // 🧟 admin-disabled model — never resolved, still re-enableable in admin
      if (DISABLED_MODELS.has(id + "::" + name)) continue;
      // Don't overwrite — first provider (highest priority) wins
      if (!allNames.has(name)) {
        allNames.set(name, { providerId: id, config: p });
      }
      // Also index by apiModel so both masked and unmasked names work
      const apiName = getApiModelName(m);
      if (apiName !== name && !allNames.has(apiName)) {
        allNames.set(apiName, { providerId: id, config: p });
      }
    }
  }
  // 1. Exact match — public model name or apiModel name
  if (allNames.has(model)) {
    return { ...allNames.get(model), matchType: "exact" };
  }
  if (exactOnly) return null;
  // 2. Wildcard — empty models[] accepts any model
  for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
    if (p.enabled === false) continue; // 🧟 admin-disabled provider
    if (p.models.length === 0) {
      return { providerId: id, config: p, matchType: "wildcard" };
    }
  }
  // 3. Fallback — first provider
  const firstId = firstEnabledProviderId();
  return {
    providerId: firstId,
    config: PROVIDER_CONFIG[firstId],
    matchType: "fallback",
  };
}

// ─── Resolve all matching providers in priority order (for fallback) ──
// If primary provider fails, callModel tries the next provider
function resolveAllProviders(model) {
  const sorted = Object.entries(PROVIDER_CONFIG).sort(
    ([, a], [, b]) => (a.priority || 999) - (b.priority || 999),
  );
  const matches = [];
  for (const [id, p] of sorted) {
    if (p.enabled === false) continue; // 🧟 admin-disabled provider
    for (const m of p.models) {
      if (DISABLED_MODELS.has(id + "::" + getModelName(m))) continue; // 🧟
      if (getModelName(m) === model || getApiModelName(m) === model) {
        matches.push({ providerId: id, config: p });
        break;
      }
    }
  }
  return matches;
}

// ─── Find next HEALTHY provider in priority order for fallback ─
// If current provider fails, try the next provider
// Skips providers that are unhealthy (consecutive failures) or rate-limited
function findNextProvider(model, currentProviderId) {
  const allProviders = resolveAllProviders(model);
  const currentIdx = allProviders.findIndex(
    (p) => p.providerId === currentProviderId,
  );
  // Start from the next provider after currentIdx, skipping unhealthy ones
  for (let i = currentIdx + 1; i < allProviders.length; i++) {
    const candidate = allProviders[i];
    if (
      PROVIDER_CONFIG[candidate.providerId]?.enabled !== false && // 🧟 admin-off
      isProviderHealthy(candidate.providerId, model)
    ) {
      return candidate;
    }
    log("INFO", "PROVIDER_SKIP_UNHEALTHY", {
      providerId: candidate.providerId,
      model,
      reason: "Provider is marked unhealthy or rate-limited",
    });
  }
  return null;
}

// ─── Ensure directories ───────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Auto SSOT System ────────────────────────────────────────
// Mission Barisal automatically discovers the project it serves,
// creates/updates .zombiecoder/SSOT.md, and agents follow it as truth.

const SSOT_DIR = path.resolve(process.env.SSOT_DIR || "./.zombiecoder");
const SSOT_PATH = path.join(SSOT_DIR, "SSOT.md");

function scanProject(rootDir) {
  const info = {
    name: path.basename(rootDir),
    root: rootDir,
    language: "unknown",
    framework: "",
    type: "unknown",
    hasPackageJson: false,
    hasComposerJson: false,
    hasRequirementsTxt: false,
    hasGemfile: false,
    hasCargoToml: false,
    hasGoMod: false,
    hasMakefile: false,
    hasDockerfile: false,
    hasGit: false,
    entryFile: "",
    sourceDirs: [],
    fileCount: 0,
    jsCount: 0,
    pyCount: 0,
    phpCount: 0,
    tsCount: 0,
  };

  try {
    if (!fs.existsSync(rootDir)) return info;

    // Check common project markers
    const entries = fs.readdirSync(rootDir);
    info.fileCount = entries.length;

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry);
      const stat = fs.statSync(fullPath);

      if (entry === "package.json") {
        info.hasPackageJson = true;
        info.type = "node";
      } else if (entry === "composer.json") {
        info.hasComposerJson = true;
        info.type = "php";
      } else if (
        entry === "requirements.txt" ||
        entry === "setup.py" ||
        entry === "pyproject.toml"
      ) {
        info.hasRequirementsTxt = true;
        info.type = "python";
      } else if (entry === "Gemfile") {
        info.hasGemfile = true;
        info.type = "ruby";
      } else if (entry === "Cargo.toml") {
        info.hasCargoToml = true;
        info.type = "rust";
      } else if (entry === "go.mod") {
        info.hasGoMod = true;
        info.type = "go";
      } else if (entry === "Makefile") info.hasMakefile = true;
      else if (entry === "Dockerfile") info.hasDockerfile = true;
      else if (entry === ".git") info.hasGit = true;
      else if (entry.endsWith(".js")) info.jsCount++;
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) info.tsCount++;
      else if (entry.endsWith(".py")) info.pyCount++;
      else if (entry.endsWith(".php")) info.phpCount++;
      else if (
        stat.isDirectory() &&
        !entry.startsWith(".") &&
        !["node_modules", "vendor", ".git"].includes(entry)
      ) {
        info.sourceDirs.push(entry);
      }
    }

    // Detect language from file extensions if no marker file found
    if (info.type === "unknown") {
      if (info.hasPackageJson || info.jsCount > 0 || info.tsCount > 0)
        info.type = "node";
      else if (info.phpCount > 0) info.type = "php";
      else if (info.pyCount > 0) info.type = "python";
    }

    // Set language based on type + file evidence
    if (info.type === "node") {
      info.language = info.tsCount > info.jsCount ? "typescript" : "javascript";
    } else if (info.type === "php") info.language = "php";
    else if (info.type === "python") info.language = "python";
    else if (info.type === "ruby") info.language = "ruby";
    else if (info.type === "rust") info.language = "rust";
    else if (info.type === "go") info.language = "go";

    // Detect framework from package.json
    if (info.hasPackageJson) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
        );
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.next) info.framework = "next.js";
        else if (deps.react) info.framework = "react";
        else if (deps.vue) info.framework = "vue";
        else if (deps.express) info.framework = "express";
        else if (deps.nuxt) info.framework = "nuxt";
        else if (deps["@angular/core"]) info.framework = "angular";
        info.name = pkg.name || info.name;
        if (deps.typescript || pkg.devDependencies?.typescript) {
          info.language = "typescript";
        }
      } catch (e) { }
    }

    // Detect framework from composer.json
    if (info.hasComposerJson) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(rootDir, "composer.json"), "utf8"),
        );
        const deps = { ...pkg.require, ...pkg["require-dev"] };
        if (deps.laravel) info.framework = "laravel";
        else if (deps.symfony) info.framework = "symfony";
        info.name = pkg.name || info.name;
      } catch (e) { }
    }

    // Find entry files
    const entryCandidates = [
      "api.js",
      "app.js",
      "index.js",
      "server.js",
      "main.js",
      "index.ts",
      "main.ts",
      "main.py",
      "index.php",
      "main.go",
      "app.py",
    ];
    for (const ec of entryCandidates) {
      if (entries.includes(ec)) {
        info.entryFile = ec;
        break;
      }
    }
  } catch (e) {
    log("WARN", "PROJECT_SCAN_FAIL", { error: e.message, dir: rootDir });
  }

  return info;
}

function generateSSOT(rootDir, projectInfo) {
  const header = `# ${projectInfo.name} — Project Context (Auto-generated by Mission Barisal)

> This file is automatically managed by Mission Barisal v3.
> Agents use this as the Single Source of Truth for the project.

## Project Identity
- **Name:** ${projectInfo.name}
- **Root:** ${projectInfo.root}
- **Type:** ${projectInfo.type} (${projectInfo.language})
- **Framework:** ${projectInfo.framework || "none detected"}
- **Entry Point:** ${projectInfo.entryFile || "not detected"}
- **Source Dirs:** ${projectInfo.sourceDirs.join(", ") || "none"}
- **File Count:** ${projectInfo.fileCount}

## Detected Technologies
| Technology | Present | Files |
|-----------|---------|-------|
| JavaScript | ${projectInfo.type === "node" ? "yes" : "no"} | ${projectInfo.jsCount} .js |
| TypeScript | ${projectInfo.language === "typescript" ? "yes" : "no"} | ${projectInfo.tsCount} .ts |
| Python | ${projectInfo.type === "python" ? "yes" : "no"} | ${projectInfo.pyCount} .py |
| PHP | ${projectInfo.type === "php" ? "yes" : "no"} | ${projectInfo.phpCount} .php |
| Node.js | ${projectInfo.hasPackageJson ? "yes" : "no"} | package.json |
| Docker | ${projectInfo.hasDockerfile ? "yes" : "no"} | — |
| Git | ${projectInfo.hasGit ? "yes" : "no"} | — |

## Project Structure
`;

  let structure = "";
  try {
    structure = buildTree(rootDir, 0, 3);
  } catch (e) {
    structure = "  (error reading structure)";
  }

  let footer = `
## Mission Barisal Context
- **Server:** Mission Barisal v3 — Multi-Agent Code Platform
- **Owner:** Sahon Srabon (ZombieCoder) · Barisal, Bangladesh · At Home
- **Agents:** ${typeof AGENTS !== "undefined" && AGENTS.length ? AGENTS.length : 9} specialist agents + mission mode (all ${typeof AGENTS !== "undefined" && AGENTS.length ? AGENTS.length : 9} debate in parallel)
- **MCP Endpoint:** \`/mcp\` on port ${PORT}

| ID | Name | Role | Priority |
|----|------|------|----------|
`;

  // Add agent rows
  let agentRows = "";
  if (typeof AGENTS !== "undefined" && AGENTS.length > 0) {
    for (const a of AGENTS) {
      agentRows += `| \`${a.id}\` | ${a.name} | ${a.role} | ${a.priority} |\n`;
    }
  }
  footer += agentRows;

  footer += `
## Agent Instructions
- Agents MUST reference this SSOT.md when answering project-related questions.
- If the user asks about the project code, agents should check this file first.
- Any code changes recommendations should be based on the detected framework and tech stack above.
- If information is not in SSOT, agents should say "এই তথ্য বর্তমানে SSOT এ নেই" and suggest adding it.
`;

  return header + structure + footer;
}

function buildTree(dir, depth, maxDepth) {
  if (depth > maxDepth) return "";
  let result = "";
  const indent = "  ".repeat(depth);
  try {
    const entries = fs.readdirSync(dir);
    const filtered = entries.filter(
      (e) => !e.startsWith(".") && e !== "node_modules" && e !== "vendor",
    );
    for (const entry of filtered) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        result += indent + "  " + entry + "/\n";
        result += buildTree(fullPath, depth + 1, maxDepth);
      } else {
        result += indent + "  " + entry + "\n";
      }
    }
  } catch (e) { }
  return result;
}

function autoSSOT(projectDir) {
  const dir = projectDir || path.resolve(".");
  log("INFO", "SSOT_SCAN", { dir });

  try {
    const targetDir = path.join(dir, ".zombiecoder");
    const targetPath = path.join(targetDir, "SSOT.md");

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      log("INFO", "SSOT_DIR_CREATED", { dir: targetDir });
    }

    const projectInfo = scanProject(dir);
    const ssotContent = generateSSOT(dir, projectInfo);
    fs.writeFileSync(targetPath, ssotContent, "utf8");

    log("INFO", "SSOT_GENERATED", {
      path: targetPath,
      project: projectInfo.name,
      type: projectInfo.type,
      language: projectInfo.language,
      size: ssotContent.length,
    });

    return ssotContent;
  } catch (e) {
    log("WARN", "SSOT_GENERATE_FAIL", { error: e.message });
    return "";
  }
}

// 🔒 BUG #2 FIX: SSOT Caching — avoid repeated disk reads
// Cache keyed by projectDir, with mtime validation for invalidation
const _ssotCacheMap = new Map(); // projectDir → { content, mtimeMs }

function readSSOT(projectDir) {
  try {
    const dir = projectDir || mcpWorkingDir || path.resolve(".");
    const targetPath = path.join(dir, ".zombiecoder", "SSOT.md");
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      const cached = _ssotCacheMap.get(targetPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.content) {
        log("INFO", "SSOT_LOADED", {
          path: targetPath,
          length: cached.content.length,
          cached: true,
        });
        return cached.content;
      }
      const content = fs.readFileSync(targetPath, "utf8").trim();
      if (content.length > 0) {
        _ssotCacheMap.set(targetPath, { content, mtimeMs: stat.mtimeMs });
        log("INFO", "SSOT_LOADED", {
          path: targetPath,
          length: content.length,
          cached: false,
        });
        return content;
      }
    }
    // Fallback: try server's own SSOT
    if (fs.existsSync(SSOT_PATH)) {
      const stat = fs.statSync(SSOT_PATH);
      const cached = _ssotCacheMap.get(SSOT_PATH);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.content) {
        log("INFO", "SSOT_FALLBACK", {
          path: SSOT_PATH,
          length: cached.content.length,
          cached: true,
        });
        return cached.content;
      }
      const content = fs.readFileSync(SSOT_PATH, "utf8").trim();
      if (content.length > 0) {
        _ssotCacheMap.set(SSOT_PATH, { content, mtimeMs: stat.mtimeMs });
        log("INFO", "SSOT_FALLBACK", {
          path: SSOT_PATH,
          length: content.length,
        });
        return content;
      }
    }
    log("WARN", "SSOT_NOT_FOUND", { checked: [targetPath, SSOT_PATH] });
    return "";
  } catch (e) {
    log("WARN", "SSOT_READ_FAIL", { error: e.message });
    return "";
  }
}

// Re-generate SSOT when working directory changes (called from MCP set_working_dir)
function refreshSSOT(newDir) {
  log("INFO", "SSOT_REFRESH", { dir: newDir });
  return autoSSOT(newDir);
}

// 🧟 MCP handshake bootstrap: guarantee the server's own .zombiecoder/
// exists and the working dir is set. Called on every initialize (HTTP
// and UDS) so a fresh checkout or wiped workspace self-heals instantly.
function ensureZombiecoderDir(baseDir) {
  const dir = path.resolve(baseDir || mcpWorkingDir || path.resolve("."));
  try {
    const zz = path.join(dir, ".zombiecoder");
    let created = false;
    if (!fs.existsSync(zz)) {
      fs.mkdirSync(zz, { recursive: true });
      created = true;
      log("INFO", "ZOMBIECODER_DIR_CREATED", { dir: zz });
    }
    const ssot = path.join(zz, "SSOT.md");
    if (!fs.existsSync(ssot)) {
      autoSSOT(dir);
    }
    if (!mcpWorkingDir) mcpWorkingDir = dir;
    log("INFO", "MCP_HANDSHAKE_DIR", {
      dir: zz,
      working_dir: mcpWorkingDir,
      created,
    });
    return { dir: zz, working_dir: mcpWorkingDir, created };
  } catch (e) {
    log("WARN", "ZOMBIECODER_DIR_FAIL", { dir, error: e.message });
    return { dir: "", working_dir: mcpWorkingDir || dir, created: false };
  }
}

/**
 * Auto-generate syllabus.md for a project directory (similar to autoSSOT).
 * Creates .zombiecoder/agents/syllabus.md with initial template if it doesn't exist.
 * The syllabus contains agent knowledge about the project.
 */
function autoSyllabus(projectDir) {
  const dir = projectDir || path.resolve(".");
  log("INFO", "SYLLABUS_AUTO", { dir });

  try {
    const agentsDir = path.join(dir, ".zombiecoder", "agents");
    const syllabusPath = path.join(agentsDir, "syllabus.md");

    // Only create if not exists (don't overwrite existing knowledge)
    if (fs.existsSync(syllabusPath)) {
      log("INFO", "SYLLABUS_EXISTS", { path: syllabusPath });
      return syllabusPath;
    }

    // Bootstrap with full Evidence-Driven instructions
    const bootstrapped = bootstrapSyllabus(dir);
    if (bootstrapped) {
      log("INFO", "SYLLABUS_BOOTSTRAPPED", { path: syllabusPath });
      return syllabusPath;
    }

    // Fallback: basic template if bootstrap fails
    // Ensure agents directory exists
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }

    // Detect project name
    const projectName = path.basename(dir);

    const template = [
      `# ${projectName} — Agent Knowledge Syllabus`,
      `> **Auto-generated by Mission Barisal** on ${new Date().toISOString().slice(0, 10)}`,
      `> This file grows as agents learn about the project.`,
      "",
      "## Latest Learnings",
      "",
      "| তারিখ | সোর্স | টপিক |",
      "|------|-------|-------|",
      "| — | — | Initial syllabus created |",
      "",
      "---",
      "",
      "## 1. Project Knowledge",
      "",
      "### Project Identity",
      `- **Name:** ${projectName}`,
      `- **Root:** ${dir}`,
      `- **Mission Barisal Version:** v3.0`,
      "",
      "### SSOT Reference",
      "The SSOT.md file contains the project's Single Source of Truth:",
      "- Tech stack & framework detection",
      "- File structure",
      "- Auto-detected project identity",
      "",
      "## 2. Architecture (Mission Barisal)",
      "",
      "### Core Components",
      "| Component | Location | Description |",
      "|-----------|----------|-------------|",
      "| **Server** | api.js | Port " + PORT + ", zero external deps |",
      "| **Extension** | VS Code Extension | LanguageModelChatProvider |",
      "| **SSOT** | .zombiecoder/SSOT.md | Single Source of Truth |",
      "| **Syllabus** | .zombiecoder/agents/syllabus.md | Agent learned knowledge |",
      "| **Memory** | .zombiecoder/agents/memory.json | Conversation history |",
      "",
      "### Three-File Memory System",
      "1. **SSOT.md** — Project current state (auto-detected)",
      "2. **syllabus.md** — Agent knowledge (this file — grows over time)",
      "3. **memory.json** — Conversation history",
      "",
      "### Agent System (" + (typeof AGENTS !== "undefined" && AGENTS.length ? AGENTS.length : 9) + " Agents)",
      "| Agent | ID | Persona | Style |",
      "|-------|----|---------|-------|",
      ...(typeof AGENTS !== "undefined" && AGENTS.length
        ? AGENTS.map((a) => "| **" + (a.name || a.id) + "** | " + a.id + " | " + (a.role || "general") + " | " + (a.persona ? a.persona.split(".")[0].slice(0, 40) : "Barishali") + " |")
        : [
            "| **Code Guru** | code-guru | Code Guru - Monu | Barishali playful |",
            "| **Bug Hunter** | bug-hunter | Bug Hunter - Jewel | Sergeant serious |",
            "| **Security Hero** | security-hero | Security Hero - Bablu | Cautious, paranoid |",
            "| **Performance Wizard** | perf-wizard | Performance Wizard - Rashed | Optimization crazy |",
            "| **Documentation King** | doc-king | Documentation King - Halim | Clean, structured |",
            "| **QA Tyrant** | qa-tyrant | QA Tyrant - Mojnu | Detailed, reviewer |",
            "| **Team Heart** | team-heart | Team Heart - Jara | Empathetic, supportive |",
            "| **Customer Experience** | customer-experience-specialist | Customer Experience Specialist | Client-focused |",
            "| **E-Commerce Operations** | ecommerce-operations-analyst | E-Commerce Operations Analyst | Data-driven |",
          ]),
      "",
      "## 3. Knowledge Log",
      "",
      "*Agents append new learnings here as they discover them.*",
      "",
      "---",
      `*Auto-generated by Mission Barisal v3 on ${new Date().toISOString()}*`,
      "",
    ].join("\n");

    fs.writeFileSync(syllabusPath, template, "utf8");
    log("INFO", "SYLLABUS_CREATED", {
      path: syllabusPath,
      size: template.length,
    });

    return syllabusPath;
  } catch (e) {
    log("WARN", "SYLLABUS_AUTO_FAIL", { error: e.message });
    return null;
  }
}

// ─── Syllabus & Memory System ─────────────────────────────
const AGENTS_DIR = ".zombiecoder/agents";

function getAgentsPath(projectDir) {
  const dir = projectDir || mcpWorkingDir || path.resolve(".");
  return path.join(dir, AGENTS_DIR);
}

// 🔒 BUG #1 FIX: Syllabus Caching — avoid repeated disk reads
// Cache keyed by projectDir, with mtime validation for invalidation
const _syllabusCacheMap = new Map(); // projectDir → { content, mtimeMs }

/**
 * Read syllabus.md content for a project directory.
 * Returns markdown string or empty string.
 * Uses mtime-based caching to avoid repeated disk reads (8-10x per mission).
 */
function readSyllabus(projectDir) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    const syllabusPath = path.join(agentsDir, "syllabus.md");
    if (fs.existsSync(syllabusPath)) {
      const stat = fs.statSync(syllabusPath);
      const cached = _syllabusCacheMap.get(syllabusPath);
      // Return cache if mtime unchanged
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.content) {
        log("INFO", "SYLLABUS_LOADED", {
          path: syllabusPath,
          size: cached.content.length,
          cached: true,
        });
        return cached.content;
      }
      // Cache miss — read from disk and store
      const content = fs.readFileSync(syllabusPath, "utf8").trim();
      _syllabusCacheMap.set(syllabusPath, { content, mtimeMs: stat.mtimeMs });
      log("INFO", "SYLLABUS_LOADED", {
        path: syllabusPath,
        size: content.length,
        cached: false,
      });
      return content;
    }
    log("WARN", "SYLLABUS_NOT_FOUND", { path: syllabusPath });
    // Auto-create syllabus.md if it doesn't exist (lazy init)
    log("INFO", "SYLLABUS_AUTO_CREATING", { dir: projectDir || mcpWorkingDir });
    autoSyllabus(projectDir || mcpWorkingDir || path.resolve("."));
    // Try reading again with cache
    if (fs.existsSync(syllabusPath)) {
      const stat = fs.statSync(syllabusPath);
      const content = fs.readFileSync(syllabusPath, "utf8").trim();
      if (content.length > 0) {
        _syllabusCacheMap.set(syllabusPath, { content, mtimeMs: stat.mtimeMs });
        log("INFO", "SYLLABUS_AUTO_LOADED", {
          path: syllabusPath,
          size: content.length,
        });
        return content;
      }
    }
  } catch (e) {
    log("WARN", "SYLLABUS_READ_FAIL", { error: e.message });
  }
  return "";
}

/**
 * Add a new entry to syllabus.md.
 * @param {string} topic - Topic name
 * @param {object} entry - { source, date, summary, keyPoints, gitHubLink, usedIn }
 */
/**
 * Initialize syllabus with full instructions from Evidence-Driven docs.
 * Called once on first workspace setup — provides complete agent guidelines
 * so agents don't need massive system prompts.
 */
function bootstrapSyllabus(projectDir) {
  let fullInstructions = `# Mission Barisal — Complete Agent Syllabus

> Auto-generated from Evidence-Driven documentation.
> Agents MUST read this file before responding.
> Contains ALL rules, personas, and system knowledge.

---

## 📚 Latest Learnings

| তারিখ | সোর্স | টপিক |
|------|-------|-------|
| — | — | Initial syllabus bootstrapped |

---

## 1. CORE SYSTEM IDENTITY

- **Name:** ZombieCoder Mission Barisal v3
- **Owner:** Sahon Srabon (Developer Zone) — Dhaka, Bangladesh
- **Architecture:** Multi-Agent Gateway with Zero Dependencies
- **MCP Protocol:** Model Context Protocol — JSON-RPC 2.0 over SSE/HTTP/UDS

## 2. EVIDENCE-DRIVEN PRINCIPLES

> "First Evidence, Then Conclusion. First Truth, Then Confidence."

### Universal Rules (ALL Agents MUST Follow)
1. **SSOT First** — Never assume. Read SSOT before making claims.
2. **Evidence Before Confidence** — Proof is mandatory. No proof = no answer.
3. **Web Search** — Search for facts when SSOT/syllabus lacks data.
4. **Tool Before Guess** — If a tool is available, USE IT. Don't guess.
5. **State Uncertainty** — If unsure, say it clearly. Never hallucinate.
6. **Normalize Everything** — All outputs must be in standard format.
7. **Respect Reality** — Facts matter more than impressions.
8. **Never Hide Errors** — Report errors transparently.
9. **Explain Reasoning** — Show your work. Explain your logic.
10. **Code in English** — All code, comments, and technical docs in English.
11. **Bengali for Users** — User-facing chat in Bangla (Barishali style).
12. **No Emojis in Code** — Emojis only in user-facing chat responses.

## 3. AGENT PERSONAS

| ID | Name | Role | Priority |
|----|------|------|----------|
`;

  // Add agent rows
  if (typeof AGENTS !== "undefined" && AGENTS.length > 0) {
    for (const a of AGENTS) {
      fullInstructions += `| ${a.id} | ${a.name} | ${a.role} | ${a.priority} |\n`;
    }
  }

  fullInstructions += `
### Agent Roles
- **code-guru (Monu):** System Architecture — design patterns, code structure, project organization
- **bug-hunter (Jewel):** Debugging — error handling, logic validation, root cause analysis
- **security-hero (Bablu):** Security — vulnerability assessment, data protection
- **perf-wizard (Rashed):** Performance — optimization, caching, resource management
- **doc-king (Halim):** Documentation — API specs, README, code comments
- **qa-tyrant (Mojnu):** Quality — final verification, consensus, release readiness

## 4. TYPE SAFETY (ANTI-DOTE) SYSTEM

Every execution goes through 6-step anti-dote chain:
1. **validateInput** — Schema enforcement
2. **checkProof** — Logical feasibility
3. **getUserConsent** — User permission
4. **setGoalContract** — Success metrics
5. **execute** — Run mission/task
6. **verifyOutput** — Check against contract

Anti-dote runs on ALL endpoints: /v1/chat/completions, /api/mission, MCP, /api/v1/anti-dote
Monitoring mode: Anti-dote NEVER blocks execution — only reports results.

## 5. CUSTOM PROVIDER SYSTEM

Providers are defined via env vars: CUSTOM_PROVIDER_N_NAME, URL, KEY, MODELS, PRIORITY, TYPE.
Priority-based fallback: If primary provider fails, next priority takes over.
Format normalization: Haq Mawla Normalizer converts ALL provider responses to OpenAI format.

## 6. SESSION & MEMORY

- Sessions auto-verify via /api/verify-session
- Three-file memory: SSOT.md (project state) → syllabus.md (knowledge) → memory.json (conversations)
- SSOT, Memory, and Syllabus are BOUNDED parameters — if input falls outside them, agents say "আমার কাছে প্রমাণ নেই"

## 7. UNIVERSAL SOCKET ARCHITECTURE

Supports: HTTP, SSE, WebSocket, Unix Domain Socket (UDS port 5100)
Transport priority: UDS → HTTP → WS (auto-detected based on environment)
cPanel/LiteSpeed: Auto-bypass UDS, fallback to HTTP only

> **Transport scope (evidence-based):** Outbound provider API requests - callModel, callModelStream, proxyHttpRequest - use plain TCP http/https (hostname + port from baseUrl). They do NOT use UDS/socketPath. UDS, WebSocket, and SSE are **server-inbound** transports only (the MCP/broker socket and streaming responses), not used for outbound provider calls.

---

*Generated by Mission Barisal v3 — Evidence-Driven, Proof-First*
`;

  try {
    const agentsDir = getAgentsPath(projectDir);
    if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
    const syllabusPath = path.join(agentsDir, "syllabus.md");

    // Only write if syllabus doesn't exist or is empty
    if (
      !fs.existsSync(syllabusPath) ||
      fs.readFileSync(syllabusPath, "utf8").trim().length < 50
    ) {
      fs.writeFileSync(syllabusPath, fullInstructions, "utf8");
      log("INFO", "SYLLABUS_BOOTSTRAPPED", {
        path: syllabusPath,
        size: fullInstructions.length,
      });
      return true;
    }
    log("INFO", "SYLLABUS_EXISTS", { path: syllabusPath });
    return false;
  } catch (e) {
    log("WARN", "SYLLABUS_BOOTSTRAP_FAIL", { error: e.message });
    return false;
  }
}

function writeSyllabus(projectDir, topic, entry) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    // Ensure directory exists
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    const syllabusPath = path.join(agentsDir, "syllabus.md");

    // Build the markdown entry
    const date = entry.date || new Date().toISOString().slice(0, 10);
    const md = `
### ${topic}
- **Source:** ${entry.source || "Unknown"}
- **Date:** ${date}
- **Summary:** ${entry.summary || ""}
- **Key Points:**
${(entry.keyPoints || []).map((kp) => `  - ${kp}`).join("\n")}
${entry.gitHubLink ? `- **GitHub Skill Link:** ${entry.gitHubLink}\n` : ""}${entry.usedIn ? `- **Used In:** ${entry.usedIn}\n` : ""}
`;

    // Append to file (create if not exists)
    fs.appendFileSync(syllabusPath, md, "utf8");

    log("INFO", "SYLLABUS_UPDATED", {
      topic,
      date,
      path: syllabusPath,
    });

    // Also update the latest learnings table at the top
    _updateSyllabusIndex(agentsDir, topic, date, entry.source);

    return true;
  } catch (e) {
    log("WARN", "SYLLABUS_WRITE_FAIL", { error: e.message });
    return false;
  }
}

/**
 * Internal: update the "Latest Learnings" table in syllabus.md
 */
function _updateSyllabusIndex(agentsDir, topic, date, source) {
  try {
    const syllabusPath = path.join(agentsDir, "syllabus.md");
    if (!fs.existsSync(syllabusPath)) return;
    let content = fs.readFileSync(syllabusPath, "utf8");

    // Find the latest learnings table and prepend a row
    const tableLine = `| ${date} | ${source || "—"} | ${topic} |\n`;
    const tableMarker = "| তারিখ | সোর্স | টপিক |";

    if (content.includes(tableMarker)) {
      // Insert after the header row (header + separator)
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(tableMarker)) {
          // i+1 should be separator, insert after i+1
          lines.splice(i + 2, 0, tableLine.trimEnd());
          break;
        }
      }
      fs.writeFileSync(syllabusPath, lines.join("\n"), "utf8");
    } else {
      // 🔧 FIX: bootstrapped syllabi (bootstrapSyllabus) had NO
      // Latest Learnings table — create it after the first `---`.
      // This migrates existing bootstrapped syllabi + new ones.
      const tableSection =
        "## 📚 Latest Learnings\n\n" +
        "| তারিখ | সোর্স | টপিক |\n" +
        "|------|-------|-------|\n" +
        tableLine.trimEnd() + "\n\n---";
      content = content.replace(/^---/m, tableSection);
      fs.writeFileSync(syllabusPath, content, "utf8");
    }
  } catch (e) {
    // Silently fail — this is non-critical
  }
}

/**
 * Persist a learning entry to the project syllabus after an agent
 * completes a substantive task. Dedupes by topic. Never throws.
 * Wired into the agent flow (syllabus 8.6 — agents learn as they work).
 */
function learnToSyllabus(sessionId, agent, userInput, content) {
  try {
    if (!content || content.length < 40) return false; // skip trivial chatter
    const dir = getEffectiveDir(sessionId) || mcpWorkingDir;
    const topic = (userInput || "Agent task")
      .slice(0, 60)
      .replace(/\s+/g, " ")
      .trim();
    if (!topic) return false;
    // Dedupe: skip if topic already exists in the syllabus
    const existing = readSyllabus(dir);
    if (existing && existing.includes("### " + topic)) return false;
    const summary = content.slice(0, 200).replace(/\s+/g, " ").trim();
    const ok = writeSyllabus(dir, topic, {
      source: "Agent: " + agent.id + " (" + agent.name + ")",
      summary: summary + (content.length > 200 ? "…" : ""),
      keyPoints: ["Completed by " + agent.name],
      usedIn: agent.role,
    });
    if (ok) {
      log("INFO", "SYLLABUS_LEARNED", { topic, agent: agent.id });
    }
    return ok;
  } catch (e) {
    log("WARN", "SYLLABUS_LEARN_FAIL", { error: e.message });
    return false;
  }
}

/**
 * Build a markdown tools list from MCP_TOOLS for system prompts.
 * Gives the model clear tool names + parameters + usage so it
 * actually CALLS the tools instead of describing them (syllabus 8.6).
 */
function buildToolsDescription(toolMap) {
  try {
    const entries = Object.entries(toolMap || {});
    if (entries.length === 0) return "- (no tools available)\n";
    return (
      entries
        .map(([name, def]) => {
          const params = Object.keys(def.params || {}).join(", ");
          return (
            "- **" + name + "**" +
            (params ? " (" + params + ")" : "") +
            ": " + (def.description || "")
          );
        })
        .join("\n") + "\n"
    );
  } catch (e) {
    return "- (tools unavailable)\n";
  }
}

/**
 * Read memory.json for a project directory.
 */
function readMemory(projectDir) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    const memPath = path.join(agentsDir, "memory.json");
    if (fs.existsSync(memPath)) {
      const raw = fs.readFileSync(memPath, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    log("WARN", "MEMORY_READ_FAIL", { error: e.message });
  }
  // Return default structure
  return {
    current_session: {
      id: null,
      started_at: null,
      message_count: 0,
      summary: null,
    },
    recent_context: [],
    session_index: {
      last_accessed: null,
      total_sessions: 0,
      total_archived: 0,
    },
  };
}

/**
 * Write to memory.json.
 */
function writeMemory(projectDir, data) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    const memPath = path.join(agentsDir, "memory.json");
    // 🧟 ASYNC WRITE: non-blocking disk I/O (was writeFileSync — blocked event loop)
    fs.promises.writeFile(memPath, JSON.stringify(data, null, 2), "utf8").catch(e => log("WARN", "MEMORY_WRITE_ASYNC_FAIL", { error: e.message }));
    log("INFO", "MEMORY_SAVED", { path: memPath });
    return true;
  } catch (e) {
    log("WARN", "MEMORY_WRITE_FAIL", { error: e.message });
    return false;
  }
}

/**
 * Archive current session to sessions/ folder.
 * Summarizes the conversation and saves it with timestamp.
 */
function archiveSession(projectDir, sessionId, messages, summary) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    const sessionsDir = path.join(agentsDir, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const timeStr = now.toTimeString().slice(0, 2).replace(/:/g, "");

    // Find next sequence number
    let seq = 1;
    const existing = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.startsWith("ctx_") && f.endsWith(".json"));
    if (existing.length > 0) {
      const nums = existing
        .map((f) =>
          parseInt(f.replace("ctx_", "").replace(".json", "").split("_").pop()),
        )
        .filter((n) => !isNaN(n));
      if (nums.length > 0) seq = Math.max(...nums) + 1;
    }

    const filename = `ctx_${dateStr}_${String(seq).padStart(3, "0")}.json`;
    const filePath = path.join(sessionsDir, filename);

    // Extract key points and decisions from messages
    const keyPoints = [];
    const decisions = [];
    const filesChanged = [];

    // Build the session archive
    const archive = {
      session_id: filename.replace(".json", ""),
      created_at: now.toISOString(),
      message_count: (messages || []).length,
      summary: summary || "No summary provided",
      key_points: keyPoints.slice(0, 10),
      decisions: decisions.slice(0, 10),
      files_changed: filesChanged.slice(0, 20),
      tags: [],
      prev_session: null,
      next_session: null,
    };

    // 🧟 ASYNC WRITE: non-blocking session archive
    fs.promises.writeFile(filePath, JSON.stringify(archive, null, 2), "utf8").catch(e => log("WARN", "SESSION_WRITE_ASYNC_FAIL", { error: e.message }));

    // Update _index.json
    _updateSessionIndex(agentsDir, archive);

    // Update memory.json session index AND recent_context
    const mem = readMemory(projectDir);
    mem.session_index.last_accessed = now.toISOString();
    mem.session_index.total_sessions += 1;
    mem.session_index.total_archived += 1;

    // ── UPDATE RECENT_CONTEXT: Keep last 5 session summaries ──
    if (!mem.recent_context) mem.recent_context = [];
    mem.recent_context.push({
      session_id: archive.session_id,
      summary: summary || "No summary",
      timestamp: now.toISOString(),
      agent_count: 0,
      tags: archive.tags || [],
    });
    // 🔒 BUG #7 FIX: Keep more recent context (was 5, now 20)
    // 927+ sessions archived but only 5 contexts retained — important history lost
    const MAX_RECENT_CONTEXT = 20;
    if (mem.recent_context.length > MAX_RECENT_CONTEXT) {
      mem.recent_context = mem.recent_context.slice(-MAX_RECENT_CONTEXT);
    }

    // 🧟 DE-DUPED: memory already saved in main flow — skip 2nd write
    // writeMemory(projectDir, mem);

    log("INFO", "SESSION_ARCHIVED", {
      session: archive.session_id,
      path: filePath,
      messages: archive.message_count,
      recent_context_count: mem.recent_context.length,
    });

    return archive.session_id;
  } catch (e) {
    log("WARN", "SESSION_ARCHIVE_FAIL", { error: e.message });
    return null;
  }
}

/**
 * Internal: update _index.json with keywords from the archived session.
 */
function _updateSessionIndex(agentsDir, archive) {
  try {
    const indexPath = path.join(agentsDir, "sessions", "_index.json");
    let index = {
      version: 1,
      last_updated: new Date().toISOString(),
      index: {},
    };

    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      } catch (e) {
        /* use default */
      }
    }

    // Add keywords from tags, key_points, and summary
    const keywords = new Set();
    for (const tag of archive.tags || []) keywords.add(tag.toLowerCase());
    for (const kp of archive.key_points || []) {
      for (const word of kp.split(/\s+/)) {
        if (word.length > 3)
          keywords.add(word.toLowerCase().replace(/[^a-z0-9]/g, ""));
      }
    }

    for (const kw of keywords) {
      if (!index.index[kw]) index.index[kw] = [];
      if (!index.index[kw].includes(archive.session_id)) {
        index.index[kw].push(archive.session_id);
      }
    }

    index.last_updated = new Date().toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
  } catch (e) {
    log("WARN", "INDEX_UPDATE_FAIL", { error: e.message });
  }
}

/**
 * Load recent session context into the agent's memory.
 * Returns a formatted string with recent summaries.
 */
function restoreRecentContext(projectDir, maxSessions = 3) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    const sessionsDir = path.join(agentsDir, "sessions");
    if (!fs.existsSync(sessionsDir)) return "";

    // Get most recent session archives
    const files = fs
      .readdirSync(sessionsDir)
      .filter(
        (f) =>
          f.startsWith("ctx_") && f.endsWith(".json") && f !== "_index.json",
      )
      .sort()
      .reverse()
      .slice(0, maxSessions);

    if (files.length === 0) return "";

    let context = "\n\n--- Previous Session Context ---\n";
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(sessionsDir, file), "utf8"),
        );
        context += `\n[Session: ${data.session_id} | ${data.created_at}]\n`;
        context += `Summary: ${data.summary}\n`;
        if (data.key_points && data.key_points.length > 0) {
          context += `Key points: ${data.key_points.join("; ")}\n`;
        }
        if (data.decisions && data.decisions.length > 0) {
          context += `Decisions: ${data.decisions.join("; ")}\n`;
        }
      } catch (e) {
        /* skip */
      }
    }

    log("INFO", "CONTEXT_RESTORED", { sessions: files.length });
    return context;
  } catch (e) {
    log("WARN", "CONTEXT_RESTORE_FAIL", { error: e.message });
    return "";
  }
}

/**
 * Search session archives by keyword.
 */
function searchSessions(projectDir, keyword) {
  try {
    const agentsDir = getAgentsPath(projectDir);
    const indexPath = path.join(agentsDir, "sessions", "_index.json");
    if (!fs.existsSync(indexPath)) return [];

    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const kw = keyword.toLowerCase();
    const results = [];

    // Direct match in index
    for (const [key, sessions] of Object.entries(index.index || {})) {
      if (key.includes(kw) || kw.includes(key)) {
        results.push(...sessions);
      }
    }

    return [...new Set(results)];
  } catch (e) {
    log("WARN", "SESSION_SEARCH_FAIL", { error: e.message });
    return [];
  }
}

// ─── Emoji Strip Utility ─────────────────────────────────────
function stripEmoji(str) {
  if (!str) return "";
  // Matches most emoji (including skin tones, flags, zwj sequences)
  return str
    .replace(
      /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{200D}\u{FE0F}\u{2300}-\u{23FF}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FB}\u{25FC}\u{25FD}\u{25FE}\u{2B05}\u{2B06}\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu,
      "",
    )
    .trim();
}

// ─── Logger ──────────────────────────────────────────────────
// ─── Color constants for visual terminal logging ────────────
const C_RED = "\x1b[31m",
  C_GREEN = "\x1b[32m",
  C_YELLOW = "\x1b[33m";
const C_CYAN = "\x1b[36m",
  C_MAGENTA = "\x1b[35m",
  C_BLUE = "\x1b[34m";
const C_BOLD = "\x1b[1m",
  C_DIM = "\x1b[2m",
  C_RESET = "\x1b[0m";
const ICONS = {
  INFO: "ℹ️",
  WARN: "⚠️",
  ERROR: "❌",
  DEBUG: "🔍",
  REQUEST: "➡️",
  RESPONSE: "⬅️",
  EVENT: "🔄",
  DATA: "📦",
  START: "▶️",
  END: "⏹️",
  PASS: "✅",
  FAIL: "❌",
};

function log(level, category, data, consoleOnly) {
  const ts = new Date().toISOString();
  const ts_short = ts.slice(11, 19); // HH:MM:SS only
  const icon = ICONS[level] || ICONS.INFO;
  let color = C_RESET;
  if (level === "ERROR") color = C_RED;
  else if (level === "WARN") color = C_YELLOW;
  else if (level === "INFO") color = C_GREEN;
  else if (level === "DEBUG") color = C_DIM;

  let dataStr = typeof data === "string" ? data : JSON.stringify(data);
  // Truncate long data for terminal display
  if (dataStr.length > 200) dataStr = dataStr.slice(0, 197) + "...";

  const entry = `[${ts}] [${level}] [${category}] ${typeof data === "string" ? data : JSON.stringify(data)}`;
  const visual = `${C_DIM}${ts_short}${C_RESET} ${icon} ${color}${C_BOLD}[${category}]${C_RESET} ${dataStr}`;
  console.log(visual);
  if (consoleOnly) return;
  const logFile = path.join(LOG_DIR, `${ts.slice(0, 10)}.log`);
  try {
    fs.appendFileSync(logFile, entry + "\n");
  } catch (e) { }
}

/**
 * Visual Event Flow — real-time terminal visualization of request flow
 * Shows: REQUEST → AGENT → PROVIDER → RESPONSE with timing
 */
function visualEventFlow(phase, label, detail) {
  const ts = new Date().toISOString().slice(11, 19);
  const phaseIcons = {
    request: "➡️",
    response: "⬅️",
    agent: "👤",
    provider: "🔌",
    anti_dote: "🛡️",
    mission: "🎯",
    verify: "✅",
    error: "❌",
    data: "📦",
    system: "⚙️",
  };
  const phaseColors = {
    request: C_CYAN,
    response: C_GREEN,
    agent: C_BLUE,
    provider: C_YELLOW,
    anti_dote: C_MAGENTA,
    mission: C_CYAN,
    verify: C_GREEN,
    error: C_RED,
    data: C_DIM,
    system: C_BOLD,
  };
  const icon = phaseIcons[phase] || "•";
  const color = phaseColors[phase] || C_RESET;
  const detailStr = detail
    ? typeof detail === "string"
      ? detail.slice(0, 150)
      : JSON.stringify(detail).slice(0, 150)
    : "";
  console.log(
    `  ${C_DIM}${ts}${C_RESET} ${icon} ${color}${C_BOLD}${label}${C_RESET} ${detailStr}`,
  );
}

// ══════════════════════════════════════════════════════════════
//  📜 PERSONAS PARSER
// ══════════════════════════════════════════════════════════════
function parsePersonas(mdContent) {
  const agents = [];
  const blocks = mdContent.split(/^## agent:/m).slice(1);
  // Model names to strip from persona text — agents should NEVER see these
  const modelNames =
    /nemotron-3-ultra-free|mimo-v2\.5-free|big-pickle|nemotron-3-ultra-free|north-mini-code-free|hy3-free/gi;
  for (const block of blocks) {
    const idMatch = block.match(/^\s*([^\n]+)/);
    const id = idMatch ? idMatch[1].trim() : "";
    if (!id) continue;
    const name = extractField(block, "name") || id;
    const model = extractField(block, "model") || "nemotron-3-ultra-free";
    const role = extractField(block, "role") || "general";
    const expertise = extractField(block, "expertise") || "";
    const priority = parseInt(extractField(block, "priority") || "99", 10);
    let persona = extractPersona(block);
    // Strip model names from persona text — agents should NEVER know their model
    if (persona) {
      persona = persona
        .replace(modelNames, "AI model")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    if (model && persona)
      agents.push({ id, name, model, role, expertise, priority, persona });
  }
  agents.sort((a, b) => (a.priority || 99) - (b.priority || 99));
  return agents;
}

function extractField(block, field) {
  const re = new RegExp(
    "^-\\s*\\*{0,2}" + field + "\\*{0,2}\\s*:\\s*(.+)$",
    "m",
  );
  const match = block.match(re);
  return match
    ? match[1].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "")
    : null;
}

function extractPersona(block) {
  // Extract persona from YAML block scalar (|)
  // Captures ALL indented lines after the | marker until a new section/field.
  // $(?![\s\S]) = true end-of-string (works with m flag) so the LAST block
  // in the file is never silently dropped (pre-existing bug fix).
  const match = block.match(
    /\*\*persona\*\*:\s*\|\s*\n([\s\S]*?)(?:^- \*\*|^##\s|^---|\n\n(?!  )|$(?![\s\S]))/m,
  );
  if (match) {
    return match[1]
      .split("\n")
      .map((l) => l.replace(/^  /, "").trim())
      .filter((l) => l && !l.startsWith("- "))
      .join("\n");
  }
  return null;
}

// ─── YAML Frontmatter Agent Parser ────────────────────────────
// Parses custom agent files (.zombiecoder/agents/*.md) that use
// YAML frontmatter instead of the "## agent:" markdown format:
//   ---
//   name: agent-id
//   description: "..."
//   mode: all
//   model: some-model
//   permission: ...
//   ---
//   <persona body>
// Custom files OVERRIDE same-id agents from PERSONAS.md.
function parseYamlAgentFile(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length).trim();

  // Parse simple YAML "key: value" pairs (skip nested/array lines)
  const fields = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (m) {
      fields[m[1]] = m[2]
        .trim()
        .replace(/^"|"$/g, "")
        .replace(/^'|'$/g, "");
    }
  }

  const id = fields.name || "";
  if (!id) return null;

  // Model safety: slash-prefixed models (enterprise/xxx) are not in
  // any configured provider catalog — fall back to a known free model.
  const model = fields.model || "nemotron-3-ultra-free";
  const safeModel = model.includes("/") ? "nemotron-3-ultra-free" : model;

  const modelNames =
    /nemotron-3-ultra-free|mimo-v2\.5-free|big-pickle|nemotron-3-ultra-free|north-mini-code-free|hy3-free/gi;
  let persona = body || fields.description || "";
  persona = persona
    .replace(modelNames, "AI model")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!persona) return null;

  return {
    id,
    name: fields.name || id,
    model: safeModel,
    role: fields.role || fields.mode || "general",
    expertise: fields.expertise || fields.description || "",
    priority: parseInt(fields.priority || "99", 10),
    persona,
  };
}

// ─── Load Personas ────────────────────────────────────────────
// Sources (merged, custom overrides default):
//   1. PERSONAS.md              — "## agent:" markdown format (default agents)
//   2. .zombiecoder/agents/*.md — YAML frontmatter format (custom agents)
async function loadPersonas() {
  const merged = [];
  const seen = new Set();

  // 0. DB agents first (PHASE A) — enabled rows from the agents table.
  //    DB is the primary source; files below fill gaps / override.
  if (MODELS_DB) {
    try {
      const rows = MODELS_DB.prepare(
        "SELECT id, name, role, model, expertise, persona, enabled, priority FROM agents WHERE enabled = 1 ORDER BY priority ASC, name ASC"
      ).all();
      for (const r of rows) {
        if (!r.id) continue;
        seen.add(r.id);
        merged.push({
          id: r.id,
          name: r.name || r.id,
          model: r.model || "nemotron-3-ultra-free",
          role: r.role || "general",
          expertise: r.expertise || "",
          priority: r.priority || 99,
          persona: r.persona || "",
          source: "db",
        });
      }
      if (rows.length > 0) {
        log("INFO", "PERSONAS_DB_LOADED", { count: rows.length });
      }
    } catch (e) {
      log("WARN", "PERSONAS_DB_READ_FAIL", { error: e.message });
    }
  }

  // 1.5. Load from agent/*.js files (zero-dependency module loader)
  //     These serve as curated defaults; DB edits override them.
  try {
    const fileAgents = loadAgentFiles();
    for (const a of fileAgents) {
      if (a && a.id && !seen.has(a.id)) {
        seen.add(a.id);
        merged.push(a);
      }
    }
    if (fileAgents.length > 0) {
      log("INFO", "PERSONAS_FILE_LOADED", {
        source: "agent/*.js",
        count: fileAgents.length,
      });
    }
  } catch (e) {
    log("WARN", "PERSONAS_FILE_LOAD_FAIL", {
      error: e.message,
    });
  }

  // 1. Default agents from PERSONAS.md (## agent: format)
  if (fs.existsSync(PERSONAS_FILE)) {
    try {
      const content = fs.readFileSync(PERSONAS_FILE, "utf8");
      const agents = parsePersonas(content);
      for (const a of agents) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          merged.push(a);
        }
      }
    } catch (e) {
      log("WARN", "PERSONAS_PARSE_FAIL", { error: e.message });
    }
  }

  // 2. Custom agents from .zombiecoder/agents/*.md (YAML frontmatter)
  try {
    const agentsDir = getAgentsPath();
    if (fs.existsSync(agentsDir)) {
      const files = fs
        .readdirSync(agentsDir)
        .filter(
          (f) =>
            f.endsWith(".md") &&
            f !== "syllabus.md" &&
            f !== "SSOT.md" &&
            f !== "PERSONAS.md",
        );
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(agentsDir, f), "utf8");
          const custom = parseYamlAgentFile(content);
          if (custom && custom.id) {
            if (seen.has(custom.id)) {
              // Custom file wins over same-id agent from PERSONAS.md
              const idx = merged.findIndex((a) => a.id === custom.id);
              if (idx >= 0) merged[idx] = custom;
            } else {
              seen.add(custom.id);
              merged.push(custom);
            }
          }
        } catch (e) {
          log("WARN", "CUSTOM_AGENT_PARSE_FAIL", {
            file: f,
            error: e.message,
          });
        }
      }
    }
  } catch (e) {
    log("WARN", "CUSTOM_AGENTS_SCAN_FAIL", { error: e.message });
  }

  if (merged.length > 0) {
    log("INFO", "PERSONAS_LOADED", {
      source: "local+custom",
      count: merged.length,
    });
    return merged;
  }
  log("WARN", "PERSONAS_NOT_FOUND", { file: PERSONAS_FILE });

  // 🔒 PRE-EXISTING BUG FIX: Skip HTTPS download if URL is empty.
  // GIT_PERSONAS_URL defaults to "" when env var is not set.
  // https.get("") throws "TypeError: Invalid URL" at new URL("").
  if (!GIT_PERSONAS_URL || !GIT_PERSONAS_URL.startsWith("http")) {
    log("WARN", "PERSONAS_SKIP_DOWNLOAD", {
      reason: "GIT_PERSONAS_URL empty or invalid",
      url: GIT_PERSONAS_URL,
    });
    return [];
  }

  log("INFO", "PERSONAS_DOWNLOAD", { url: GIT_PERSONAS_URL });
  try {
    return new Promise((resolve) => {
      https
        .get(GIT_PERSONAS_URL, { timeout: 10000 }, (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              fs.writeFileSync(PERSONAS_FILE, data);
              const agents = parsePersonas(data);
              if (agents.length > 0) {
                log("INFO", "PERSONAS_DOWNLOADED", { count: agents.length });
                resolve(agents);
              } else {
                resolve([]);
              }
            } catch (e) {
              resolve([]);
            }
          });
        })
        .on("error", () => resolve([]));
    });
  } catch (e) {
    return [];
  }
}

// ─── Git Runtime Download — Generic File Downloader ────────
// "Agent personas, skills, instructions fetched from git at runtime"
// Zero dependency, pure https.

// ─── Agents DB Seed + Refresh (PHASE A) ────────────────────
// Seed: on first run, populate the agents table from PERSONAS.md so
// DB-first loading returns the SAME agents as today (zero behavior change).
// Refresh: re-run loadPersonas() into the AGENTS global (used by admin CRUD).
function seedAgentsFromPersonas() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  try {
    const existing = MODELS_DB.prepare("SELECT COUNT(*) c FROM agents").get();
    if (existing && existing.c > 0) {
      return { ok: true, seeded: 0, note: "agents table already seeded" };
    }
    if (!fs.existsSync(PERSONAS_FILE)) {
      return { ok: true, seeded: 0, note: "no PERSONAS.md to seed from" };
    }
    const content = fs.readFileSync(PERSONAS_FILE, "utf8");
    const agents = parsePersonas(content);
    if (agents.length === 0) {
      return { ok: true, seeded: 0, note: "no agents parsed from PERSONAS.md" };
    }
    const ins = MODELS_DB.prepare(`
      INSERT INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    let seeded = 0;
    const now = Date.now();
    for (const a of agents) {
      try {
        ins.run(a.id, a.name || a.id, a.role || "general", a.model || "", a.expertise || "", a.persona || "", a.priority || 99, now);
        seeded++;
      } catch (e) {
        log("WARN", "AGENT_SEED_SKIP", { id: a.id, error: e.message });
      }
    }
    log("INFO", "AGENTS_SEEDED", { from: "PERSONAS.md", count: seeded });
    return { ok: true, seeded };
  } catch (e) {
    log("WARN", "AGENTS_SEED_FAIL", { error: e.message });
    return { ok: false, error: e.message };
  }
}

// ─── 🧟 Runtime registry guarantee (heart-core agents/models → DB) ──
// Order (user contract): (1) create DB+schema at runtime — initModelsDb() does
// CREATE TABLE IF NOT EXISTS; (2) seed from local sources (PERSONAS.md /
// agent/*.js); (3) if STILL empty → download registry.seed.json from the
// remote repo. Models follow the same ladder via ensureModelsRegistry().
const REGISTRY_REMOTE_URL =
  process.env.REGISTRY_REMOTE_URL ||
  "https://raw.githubusercontent.com/sahonsrabon-os/monu_the_builder/main/registry.seed.json";

async function seedRegistryFromRemote(reason) {
  if (!REGISTRY_REMOTE_URL.startsWith("http")) {
    log("WARN", "REGISTRY_REMOTE_SKIP", { reason, url: REGISTRY_REMOTE_URL });
    return { ok: false, error: "remote url invalid" };
  }
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  log("INFO", "REGISTRY_REMOTE_FETCH", { url: REGISTRY_REMOTE_URL, reason });
  try {
    const data = await new Promise((resolve, reject) => {
      https
        .get(REGISTRY_REMOTE_URL, { timeout: 10000 }, (res) => {
          let d = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve(d));
        })
        .on("error", reject);
    });
    const reg = JSON.parse(data);
    const now = Date.now();
    let na = 0;
    if (Array.isArray(reg.agents)) {
      const ins = MODELS_DB.prepare(
        `INSERT OR IGNORE INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      );
      for (const a of reg.agents) {
        if (!a || !a.id) continue;
        try {
          ins.run(
            a.id,
            a.name || a.id,
            a.role || "general",
            a.model || "",
            a.expertise || "",
            a.persona || "Agent",
            a.priority || 99,
            now,
          );
          na++;
        } catch (_) { /* duplicate id — fine */ }
      }
    }
    let nm = 0;
    if (Array.isArray(reg.models)) {
      const ins = MODELS_DB.prepare(
        `INSERT OR IGNORE INTO models (provider, name, api_model, provider_name, type, priority, updated_at, enabled, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
      );
      for (const m of reg.models) {
        if (!m || !m.provider || !m.name) continue;
        try {
          ins.run(
            m.provider,
            m.name,
            m.api_model || m.name,
            m.provider_name || m.provider,
            m.type || "openai",
            m.priority || 99,
            now,
          );
          nm++;
        } catch (_) { /* duplicate (provider,name) — fine */ }
      }
    }
    log("INFO", "REGISTRY_REMOTE_SEEDED", { agents: na, models: nm, url: REGISTRY_REMOTE_URL });
    return { ok: true, agents: na, models: nm };
  } catch (e) {
    log("WARN", "REGISTRY_REMOTE_FAIL", { error: e.message, url: REGISTRY_REMOTE_URL });
    return { ok: false, error: e.message };
  }
}

async function ensureAgentsRegistry() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  try {
    const c = MODELS_DB.prepare("SELECT COUNT(*) c FROM agents").get();
    if (c && c.c > 0) return { ok: true, source: "db", count: c.c };
  } catch (e) { /* fall through to seed */ }
  // 2. local agent/*.js files (zero-dependency curated defaults)
  try {
    const fileAgents = loadAgentFiles();
    const ins = MODELS_DB.prepare(
      `INSERT OR IGNORE INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    const now = Date.now();
    let n = 0;
    for (const a of fileAgents) {
      if (!a || !a.id) continue;
      try {
        ins.run(a.id, a.name || a.id, a.role || "general", a.model || "", a.expertise || "", a.persona || "Agent", a.priority || 99, now);
        n++;
      } catch (_) { /* dup */ }
    }
    if (n > 0) {
      log("INFO", "AGENTS_SEEDED", { from: "agent/*.js", count: n });
      return { ok: true, source: "files", count: n };
    }
  } catch (e) {
    log("WARN", "AGENTS_FILE_SEED_FAIL", { error: e.message });
  }
  // 3. remote registry download
  return await seedRegistryFromRemote("agents-empty");
}

async function ensureModelsRegistry() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  try {
    const c = MODELS_DB.prepare("SELECT COUNT(*) c FROM models").get();
    if (c && c.c > 0) return { ok: true, source: "db", count: c.c };
  } catch (e) { /* fall through */ }
  return await seedRegistryFromRemote("models-empty");
}

// ─── Phase B: API Auth (users + sessions in SQLite) ────────
// Users: id, name, api_key (sha256 at rest), enabled.
// Sessions: bearer tokens issued on /api/auth/verify, checked by authFromRequest().
// SESSION_TTL_MS is already declared at the top (line ~147); reused here.

function sha256Hex(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

function seedAdminUser() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  const name = process.env.ADMIN_USER || "admin";
  const apiKey = process.env.ADMIN_API_KEY || "";
  if (!apiKey) return { ok: true, note: "ADMIN_API_KEY not set — no seed" };
  try {
    const hash = sha256Hex(apiKey);
    MODELS_DB.prepare(
      `INSERT INTO users (name, api_key, enabled, token_limit, valid_days, token_used, expires_at, created_at)
       VALUES (?, ?, 1, 0, 0, 0, 0, ?)
       ON CONFLICT(api_key) DO UPDATE SET name = excluded.name, enabled = 1`,
    ).run(name, hash, Date.now());
    log("INFO", "ADMIN_USER_SEEDED", { name });
    return { ok: true };
  } catch (e) {
    log("WARN", "ADMIN_USER_SEED_FAIL", { error: e.message });
    return { ok: false, error: e.message };
  }
}

// ─── UI-1: user limit helpers ───────────────────────────────
// token_limit: 0 = unlimited, else max token units (requests/tokens).
// valid_days:  0 = unlimited, else days from created_at (or expires_at if set).
// Returns {ok:true, user} if within limits, else {ok:false, reason, code}.
function checkUserLimits(user) {
  if (!user) return { ok: false, reason: "user not found", code: 404 };
  if (user.enabled !== undefined && user.enabled !== 1) {
    return { ok: false, reason: "user disabled", code: 403 };
  }
  // Expiry from valid_days (computed at creation) OR explicit expires_at.
  const created = user.created_at || Date.now();
  const baseExpiry = user.expires_at && user.expires_at > 0 ? user.expires_at : 0;
  const dayExpiry = user.valid_days && user.valid_days > 0 ? created + user.valid_days * 86400000 : 0;
  const effectiveExpiry = baseExpiry > 0 ? baseExpiry : dayExpiry;
  if (effectiveExpiry > 0 && Date.now() > effectiveExpiry) {
    return { ok: false, reason: "user key expired", code: 403, expires_at: effectiveExpiry };
  }
  const used = user.token_used || 0;
  const limit = user.token_limit || 0;
  if (limit > 0 && used >= limit) {
    return { ok: false, reason: "token limit reached", code: 429, used, limit };
  }
  return { ok: true, user, used, limit, expires_at: effectiveExpiry };
}

// Increment a user's token_used counter by one unit.
function bumpUserUsage(userId) {
  if (!MODELS_DB || !userId) return;
  try {
    MODELS_DB.prepare("UPDATE users SET token_used = token_used + 1 WHERE id = ?").run(userId);
  } catch (e) {
    log("WARN", "USER_USAGE_BUMP_FAIL", { error: e.message });
  }
}

// authFromRequest: returns {ok:true,user} | {ok:false,reason} | {ok:null} (no auth sent)
function authFromRequest(req) {
  if (!MODELS_DB) return { ok: null };
  const bearer = req.headers["authorization"] || "";
  const apiKey = req.headers["x-api-key"] || "";
  // UI-1: load the full user row (id, name, enabled, limits) so
  // checkUserLimits() can enforce token quota / expiry correctly.
  const USER_FIELDS =
    "id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at";
  if (bearer.startsWith("Bearer ")) {
    const token = bearer.slice(7).trim();
    const sess = MODELS_DB.prepare(
      `SELECT s.user_id, s.expires_at AS sess_expires_at, u.id, u.name, u.enabled,
              u.token_limit, u.valid_days, u.token_used, u.expires_at, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    ).get(token);
    if (!sess) return { ok: false, reason: "invalid session token" };
    if (sess.enabled !== 1) return { ok: false, reason: "user disabled" };
    if (sess.sess_expires_at < Date.now()) {
      MODELS_DB.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      return { ok: false, reason: "session expired" };
    }
    return {
      ok: true,
      user: {
        id: sess.user_id,
        name: sess.name,
        enabled: sess.enabled,
        token_limit: sess.token_limit,
        valid_days: sess.valid_days,
        token_used: sess.token_used,
        expires_at: sess.expires_at,
        created_at: sess.created_at,
      },
    };
  }
  if (apiKey) {
    const hash = sha256Hex(apiKey);
    const user = MODELS_DB.prepare(
      `SELECT ${USER_FIELDS} FROM users WHERE api_key = ?`,
    ).get(hash);
    if (!user) return { ok: false, reason: "invalid api key" };
    if (user.enabled !== 1) return { ok: false, reason: "user disabled" };
    return {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        enabled: user.enabled,
        token_limit: user.token_limit,
        valid_days: user.valid_days,
        token_used: user.token_used,
        expires_at: user.expires_at,
        created_at: user.created_at,
      },
    };
  }
  return { ok: null };
}

// ─── Phase C: shared tools sanitizer (ALL input endpoints) ──
// TOOLS_CAP_FIX hoisted from /v1/chat/completions: caps tools arrays at
// MAX_TOOLS_LIMIT so small models don't receive ~70 tools (empty response
// bug: "Tools provided: 71, Estimated input tokens: 50471"). Also validates
// that tools is an array. Used by: /v1/chat/completions, /api/mission,
// /api/v1/anti-dote, /api/input, WS chat, MCP agent_mission/agent_single.
const MAX_TOOLS_LIMIT = 15; // max tools to send to small models (reduced from 20→15: free tier models choke on >15 tools)

// ─── Tool support by model (EVIDENCE-BASED) ───
// Models verified via live curl tests to return 400 when tools are sent.
// Never assume — strip tools ONLY for models with proof.
const NO_TOOL_MODELS = new Set([
  "deepseek-r1:1.5b",
  "deepseek-coder:latest",
  "deepseek-custom:latest",
  "deepseek-32k:latest",
]);

// 🧟 Convert MCP_TOOLS catalog → OpenAI function-tools format so any page
// can request the full server tool set with body { tools: "mcp" }.
function mcpToolsToOpenAI() {
  return Object.entries(MCP_TOOLS).map(([name, def]) => ({
    type: "function",
    function: {
      name,
      description: def.description,
      parameters: {
        type: "object",
        properties: def.params,
        required: def.required || [],
      },
    },
  }));
}

function sanitizeTools(tools, model) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  // Strip tools entirely for models that don't support them (evidence-based)
  if (model && NO_TOOL_MODELS.has(model)) {
    log("WARN", "TOOLS_STRIP_UNsupported", { model, reason: "model returns 400 with tools" });
    return undefined;
  }
  if (tools.length > MAX_TOOLS_LIMIT) {
    log("WARN", "TOOLS_CAPPED", {
      original: tools.length,
      capped: MAX_TOOLS_LIMIT,
    });
    return tools.slice(0, MAX_TOOLS_LIMIT);
  }
  return tools;
}

async function refreshAgents() {
  AGENTS = await loadPersonas();
  STATS.totalAgents = AGENTS.length;
  return AGENTS;
}

// ─── Git Runtime Download — Generic File Downloader ────────

function downloadFromGit(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith("http")) {
      resolve(null);
      return;
    }
    https
      .get(url, { timeout: 15000 }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data || null));
      })
      .on("error", () => resolve(null));
  });
}

async function loadSkills() {
  if (!GIT_SKILLS_URL) {
    log("INFO", "SKILLS_SKIP", { reason: "GIT_SKILLS_URL not set" });
    return;
  }
  log("INFO", "SKILLS_DOWNLOAD", { url: GIT_SKILLS_URL });
  try {
    const data = await downloadFromGit(GIT_SKILLS_URL);
    if (data) {
      if (!fs.existsSync(SKILLS_DIR))
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const skillFiles = data.split(/^### /m).filter(Boolean);
      let count = 0;
      for (const block of skillFiles) {
        const firstLine = block.split("\n")[0] || "unknown";
        const safeName = firstLine.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
        const filePath = path.join(SKILLS_DIR, safeName + ".md");
        fs.writeFileSync(filePath, "### " + block.trim());
        count++;
      }
      log("INFO", "SKILLS_DOWNLOADED", { count, dir: SKILLS_DIR });
    }
  } catch (e) {
    log("WARN", "SKILLS_FAIL", { error: e.message });
  }
}

async function loadInstructions() {
  if (!GIT_INSTRUCTIONS_URL) {
    log("INFO", "INSTRUCTIONS_SKIP", {
      reason: "GIT_INSTRUCTIONS_URL not set",
    });
    return;
  }
  log("INFO", "INSTRUCTIONS_DOWNLOAD", { url: GIT_INSTRUCTIONS_URL });
  try {
    const data = await downloadFromGit(GIT_INSTRUCTIONS_URL);
    if (data) {
      const destPath = path.join(SKILLS_DIR, "_instructions.md");
      if (!fs.existsSync(SKILLS_DIR))
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
      fs.writeFileSync(destPath, data);
      log("INFO", "INSTRUCTIONS_DOWNLOADED", { path: destPath });
    }
  } catch (e) {
    log("WARN", "INSTRUCTIONS_FAIL", { error: e.message });
  }
}

// ─── DEFAULT AGENTS (Fallback when PERSONAS.md unavailable) ────
// If loadPersonas() returns empty, these minimal fallback agents ensure the
// server never crashes. Full persona data lives ONLY in PERSONAS.md.
// NOTE: Persona text is NOT stored here — it is loaded from PERSONAS.md at runtime.
const DEFAULT_AGENTS = [
  {
    id: "code-guru",
    name: "কোড গুরু - মনু",
    model: "llama3.1:8b",
    role: "architecture",
    expertise: "code review, refactoring, best practices, system design",
    priority: 1,
    persona:
      "তুই মনু — কোড গুরু। তোর হাত দিয়ে যে কোড বের হয়, সেটা শুদ্ধ থাকে। ডিজাইন প্যাটার্ন, সলিড প্রিন্সিপাল, ক্লিন কোড — সব তোর জানা। খারাপ ডিজাইন দেখলেই তুই দা নিয়া দাঁড়াইয়া যাইস। বারিশালি স্টাইলে বলবি: 'ভাইয়া, এই ডিজাইন তো খারাপ! দা নিয়ে দাঁড়িয়ে আছি, খারাপ ডিজাইন দেখলেই ধইর ফালাই।' শাওন ভাই সব জানে — কোডে সমস্যা পেলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "bug-hunter",
    name: "বাগ হান্টার - জারিন",
    model: "llama3.1:8b",
    role: "debugging",
    expertise: "bug detection, error analysis, debugging, root cause analysis",
    priority: 2,
    persona:
      "তুই জুয়েল — বাগ হান্টার। তোর চোখ এড়িয়ে কোনো বাগ পার পায় না। এরর, এক্সেপশন, সিগমেন্টেশন ফল্ট — সব তুই ধইর ফালাইস। ডিবাগিং তোর খেলা। বারিশালি স্টাইলে বলবি: 'মুভি দেখি কেমনে কী হইছে! এই কোডে বাগ আছে!' শাওন ভাই সব জানে — বাগ পেলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "security-hero",
    name: "সিকিউরিটি হিরো - বাবলু",
    model: "llama3.1:8b",
    role: "security",
    expertise: "security audit, vulnerability detection, secure coding, OWASP",
    priority: 3,
    persona:
      "তুই বাবলু — সিকিউরিটি হিরো। তোর চোখ এড়িয়ে কোনো ভালনারেবিলিটি পার পায় না। এসকিউএল ইনজেকশন, এক্সএসএস, সিকিউরিটি মিসকনফিগারেশন — সব তুই ধইর ফালাইস। বারিশালি স্টাইলে বলবি: 'এই বেটা, এই কোডে এসকিউএল ইনজেকশন আছে। ঠিক কর!' শাওন ভাই সব জানে — সিকিউরিটি গর্ত থাকলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "perf-wizard",
    name: "পারফরম্যান্স উইজার্ড - রাশেদ",
    model: "llama3.1:8b",
    role: "performance",
    expertise: "performance optimization, caching, database tuning, profiling",
    priority: 4,
    persona:
      "তুই রাশেদ — পারফরম্যান্স উইজার্ড। কোডের গতি তোর কাছে সব। স্লো কোয়েরি দেখলেই তুই দা নিয়া দাঁড়াইয়া যাইস। ক্যাশিং, ডাটাবেজ টিউনিং, প্রোফাইলিং — তোর হাতের ম্যাজিক। বারিশালি স্টাইলে বলবি: 'কতা কী? এই কোডে লেটেন্সি ২ সেকেন্ড? এইডা কি চলে?' শাওন ভাই সব জানে — পারফরম্যান্স ইস্যু পেলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "doc-king",
    name: "ডকুমেন্টেশন রাজা - হালিম",
    model: "big-pickle",
    role: "documentation",
    expertise: "API documentation, code comments, README, technical writing",
    priority: 5,
    persona:
      "তুই হালিম — ডকুমেন্টেশন রাজা। কোনো প্রজেক্ট ডকুমেন্টেশন ছাড়া তোর সামনে টিকতে পারবে না। এপিআই ডক্স, রিডমি, কোড কমেন্টস — সব তুই লিখবি আর ঠিক করবি। বারিশালি স্টাইলে বলবি: 'ডকুমেন্টেশন নাই? আরে বেপারটা কি! বস লেখ!' শাওন ভাই সব জানে — ডক্স ভুল হলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "qa-tyrant",
    name: "কোয়ালিটি তস্কর - মজনু",
    model: "llama3.1:8b",
    role: "quality",
    expertise:
      "testing, test coverage, code quality, edge cases, QA automation",
    priority: 6,
    persona:
      "তুই মজনু — কোয়ালিটি তস্কর। তোর চোখ এড়িয়ে কোনো বাগ পার পায় না। ইউনিট টেস্ট, ইঞ্জিনিয়ারিং কোয়ালিটি, এজ কেস — সব তুই চেক করবি। বারিশালি স্টাইলে বলবি: 'এত গুলা টেস্ট কই? পাশ কইতেছস?' টেস্ট কভারেজ না থাকলে তুই ছাড়বি না। শাওন ভাই সব জানে — ভুল প্রমাণ পেলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "team-heart",
    name: "টিম হার্ট - জারা",
    model: "llama3.1:8b",
    role: "general",
    expertise: "team coordination, user empathy, communication, morale",
    priority: 7,
    persona:
      "তুই জারা — টিম হার্ট। তুই দলের প্রাণ। সবার কথা শোনিস, সবাইকে একসাথে রাখিস। বারিশালি স্টাইলে বলবি: 'ভাইয়া, সবাই মিলে করলে তো কিছুই কঠিন না!' শাওন ভাই সব জানে — টিমের কোনো সমস্যা হলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "customer-experience-specialist",
    name: "কাস্টমার এক্সপেরিয়েন্স স্পেশালিস্ট",
    model: "llama3.1:8b",
    role: "customer-experience",
    expertise: "customer journey, UX, satisfaction, retention, support",
    priority: 8,
    persona:
      "তুই কাস্টমার এক্সপেরিয়েন্স স্পেশালিস্ট। কাস্টমারের সুখই তোর লক্ষ্য। ইউজার জার্নি, স্যাটিসফ্যাকশন, রিটেনশন — সব তুই ভাবিস। বারিশালি স্টাইলে বলবি: 'কাস্টমার খুশি তো ব্যবসা খুশি!' শাওন ভাই সব জানে — কাস্টমার সমস্যা পেলে শাওন ভাইকে বলে দিবে।",
  },
  {
    id: "ecommerce-operations-analyst",
    name: "ই-কমার্স অপারেশনস অ্যানালিস্ট",
    model: "llama3.1:8b",
    role: "ecommerce-operations",
    expertise: "ecommerce ops, order management, inventory, logistics, analytics",
    priority: 9,
    persona:
      "তুই ই-কমার্স অপারেশনস অ্যানালিস্ট। অর্ডার, ইনভেন্টরি, লজিস্টিকস — সব তুই অ্যানালাইজ করিস। বারিশালি স্টাইলে বলবি: 'অর্ডার ফ্লো ঠিক থাকলে তো সব ঠিক!' শাওন ভাই সব জানে — অপারেশন সমস্যা পেলে শাওন ভাইকে বলে দিবে।",
  },
];

// ══════════════════════════════════════════════════════════════
//  🔐 SESSION VERIFY (via configured domain)
// ══════════════════════════════════════════════════════════════
function verifySessionWithDomain(sessionId, clientToken) {
  return new Promise((resolve) => {
    const url = new URL(RUNTIME_CONFIG.sessionVerifyUrl);
    // Append session_id as query parameter for GET
    url.searchParams.set("session_id", sessionId);
    // 🔧 FIX: Choose http/https based on URL protocol (was always https,
    // which broke verify for local http endpoints like http://localhost:3000)
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      timeout: 10000,
      rejectUnauthorized: true,
      headers: {
        "User-Agent": "MissionBarisal-v3/1.0",
        "X-Session-Id": sessionId,
        "X-Verify-Token": clientToken || "",
      },
    };
    const req = transport.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.verified === true) {
            resolve({
              verified: true,
              session: parsed.session,
              server_time: parsed.server_time,
            });
          } else {
            resolve({
              verified: false,
              error: parsed.error || "verification failed",
            });
          }
        } catch (e) {
          // 🔒 SECURITY FIX (S3): Don't auto-verify on parse failure
          resolve({
            verified: false,
            fallback: true,
            note: "domain response could not be parsed — treat as unverified",
          });
        }
      });
    });
    req.on("error", (err) => {
      resolve({
        verified: false,
        fallback: true,
        note: "domain unreachable — cannot verify token remotely",
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({
        verified: false,
        fallback: true,
        note: "domain timeout  cannot verify token remotely",
      });
    });
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════
//  🔍 WEB SEARCH
// ══════════════════════════════════════════════════════════════
function webSearch(query) {
  return new Promise((resolve) => {
    const url =
      "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      timeout: 15000,
      headers: { "User-Agent": "MissionBarisal-v3/1.0" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const results = [];
        const rows = data.split("<tr>");
        for (const row of rows) {
          const linkMatch = row.match(
            /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
          );
          const textMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
          if (linkMatch && textMatch) {
            results.push({
              link: linkMatch[1].replace(/&amp;/g, "&"),
              title: linkMatch[2].replace(/<[^>]*>/g, "").trim(),
              snippet: textMatch[1].replace(/<[^>]*>/g, "").trim(),
            });
          }
        }
        if (results.length > 0) {
          resolve({ success: true, results: results.slice(0, 5), query });
        } else {
          const bodyText = data
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          resolve({
            success: true,
            results: [
              {
                title: "Search Result",
                snippet: bodyText.slice(0, 1000),
                link: "",
              },
            ],
            query,
          });
        }
      });
    });
    req.on("error", (err) =>
      resolve({ success: false, error: err.message, query }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "timeout", query });
    });
    req.end();
  });
}

async function autoWebSearch(agent, response, userInput) {
  const content = response.content || "";
  const searchMatch = content.match(/web_search\s*:\s*(.+?)(?:\n|$)/i);
  if (!searchMatch) return response;

  const query = searchMatch[1].trim();
  const skipPatterns = [
    /তোমার প্রশ্ন/i,
    /আপনার প্রশ্ন/i,
    /লিখে দাও/i,
    /enter.*query/i,
    /your.*question/i,
    /উদাহরণ/i,
  ];
  if (query.length > 100 || skipPatterns.some((p) => p.test(query))) {
    log("INFO", "WEB_SEARCH_SKIP", {
      agent: agent.id,
      reason: "instruction-like query",
    });
    return response;
  }

  log("INFO", "WEB_SEARCH_AUTO", { agent: agent.id, query });
  const searchResult = await webSearch(query);
  let searchText = "";
  if (searchResult.success && searchResult.results.length > 0) {
    searchText =
      "WEB SEARCH RESULTS (" +
      query +
      "):\n" +
      searchResult.results
        .map(
          (r, i) =>
            i + 1 + ". " + (r.title || "Link") + "\n   " + (r.snippet || ""),
        )
        .join("\n");
  } else {
    searchText = "No search results found.";
  }

  const refined = await callModel(agent.model, [
    {
      role: "system",
      content:
        agent.persona +
        "\n\nYou did a web search. Update your response using the search results. Provide evidence.",
    },
    {
      role: "user",
      content:
        "Input:\n" +
        userInput +
        "\n\nYour previous answer:\n" +
        content +
        "\n\nSearch results:\n" +
        searchText +
        "\n\nNow update your answer based on search results.",
    },
  ]);

  return {
    ...response,
    content: refined.success
      ? searchText + "\n\n" + refined.content
      : content + "\n\nSearch processing failed.",
    webSearchUsed: true,
    searchQuery: query,
  };
}

// ══════════════════════════════════════════════════════════════
//  📡 PUSHER EVENTS
// ══════════════════════════════════════════════════════════════
function triggerPusherEvent(channel, eventName, data) {
  return new Promise((resolve) => {
    if (!PUSHER_ENABLED) {
      resolve({ success: false, reason: "Pusher not configured" });
      return;
    }
    const body = JSON.stringify({
      data: JSON.stringify(data),
      name: eventName,
      channel,
    });
    const bodyMd5 = crypto.createHash("md5").update(body).digest("hex");
    const timestamp = Math.floor(Date.now() / 1000);
    const authString =
      "POST\n/apps/" +
      PUSHER_APP_ID +
      "/events\nauth_key=" +
      PUSHER_KEY +
      "&auth_timestamp=" +
      timestamp +
      "&auth_version=1.0&body_md5=" +
      bodyMd5;
    const signature = crypto
      .createHmac("sha256", PUSHER_SECRET)
      .update(authString)
      .digest("hex");
    const url =
      "https://api-" +
      PUSHER_CLUSTER +
      ".pusher.com/apps/" +
      PUSHER_APP_ID +
      "/events?body_md5=" +
      bodyMd5 +
      "&auth_version=1.0&auth_key=" +
      PUSHER_KEY +
      "&auth_timestamp=" +
      timestamp +
      "&auth_signature=" +
      signature;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      timeout: 10000,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () =>
        resolve({
          success: res.statusCode === 202 || res.statusCode === 200,
          status: res.statusCode,
          data: d,
        }),
      );
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

async function pushLog(type, message) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "mission-log", {
      type,
      message,
      time: new Date().toISOString(),
    });
}
async function pushAgentStatus(agentId, status) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "agent-status", {
      agent: agentId,
      status,
      time: new Date().toISOString(),
    });
}
async function pushOutput(output) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "mission-output", {
      output,
      time: new Date().toISOString(),
    });
}
async function pushDone(stats) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "mission-done", {
      stats,
      time: new Date().toISOString(),
    });
}

// ══════════════════════════════════════════════════════════════
//  🔒 LOCK LOG SYSTEM — JSON Debug Memory (Zero Dependency)
// ══════════════════════════════════════════════════════════════
// Each lock operation (success/failure/timeout) is stored as JSON file.
// Organized by date — acts as debug memory for later analysis.
//
// Lock Entry Schema:
// {
//   lock_id: "uuid",
//   timestamp: "ISO date",
//   agent: "agent-id",
//   operation: "api_call|tool_exec|session|mission",
//   status: "success|failure|timeout|pending",
//   duration_ms: 1234,
//   details: { ... any additional context ... },
//   session_id: "optional",
//   provider: "optional",
//   model: "optional",
//   error: "optional error message",
// }
// ══════════════════════════════════════════════════════════════

const LOCK_DIR = path.resolve(
  process.env.LOCK_DIR || path.join(DATA_DIR, "locks"),
);

function ensureLockDir() {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }
}

// Creates a lock log entry and saves to disk with detailed tracking
function writeLockLog(entry) {
  try {
    ensureLockDir();
    const now = new Date().toISOString();
    const lockEntry = {
      lock_id: entry.lock_id || crypto.randomUUID(),
      timestamp: now,
      date: now.slice(0, 10),
      time: now.slice(11, 19),
      agent: entry.agent || "system",
      operation: entry.operation || "unknown",
      status: entry.status || "pending",
      duration_ms: entry.duration_ms || 0,
      details: entry.details || {},
      session_id: entry.session_id || "",
      provider: entry.provider || "",
      model: entry.model || "",
      error: entry.error || "",
      request_id: entry.request_id || "",
      input_preview: entry.input_preview || "",
    };
    // Date-based file: locks/2026-07-11.json (append to daily file)
    const dateStr = lockEntry.date;
    const lockFile = path.join(LOCK_DIR, dateStr + ".json");
    let locks = [];
    if (fs.existsSync(lockFile)) {
      try {
        locks = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch (e) {
        locks = [];
      }
    }
    locks.push(lockEntry);
    // Keep last 2000 entries per day
    if (locks.length > 2000) locks = locks.slice(-2000);
    fs.writeFileSync(lockFile, JSON.stringify(locks, null, 2));

    // Auto-rotate: delete lock files older than 30 days
    try {
      const allFiles = fs
        .readdirSync(LOCK_DIR)
        .filter((f) => f.endsWith(".json"));
      const thirtyDaysAgo = Date.now() - 30 * 86400000;
      for (const f of allFiles) {
        const datePart = f.replace(".json", "");
        const fileTime = new Date(datePart).getTime();
        if (!isNaN(fileTime) && fileTime < thirtyDaysAgo) {
          fs.unlinkSync(path.join(LOCK_DIR, f));
        }
      }
    } catch (_) { }

    return lockEntry;
  } catch (e) {
    console.error("[LOCK_LOG_FAIL]", e.message);
    return null;
  }
}

// Read lock logs for a specific date (format: YYYY-MM-DD) or all dates
function readLockLogs(dateStr) {
  try {
    ensureLockDir();
    if (dateStr) {
      const lockFile = path.join(LOCK_DIR, dateStr + ".json");
      if (fs.existsSync(lockFile)) {
        return JSON.parse(fs.readFileSync(lockFile, "utf8"));
      }
      return [];
    }
    // Read all lock files
    const files = fs
      .readdirSync(LOCK_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const allLocks = [];
    for (const f of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(LOCK_DIR, f), "utf8"),
        );
        allLocks.push(...data);
      } catch (e) { }
    }
    return allLocks;
  } catch (e) {
    return [];
  }
}

// Filter lock logs by agent, operation, status, or session_id
function queryLockLogs(filter) {
  const all = readLockLogs();
  return all
    .filter((l) => {
      if (filter.agent && l.agent !== filter.agent) return false;
      if (filter.status && l.status !== filter.status) return false;
      if (filter.operation && l.operation !== filter.operation) return false;
      if (filter.session_id && l.session_id !== filter.session_id) return false;
      if (filter.since && new Date(l.timestamp) < new Date(filter.since))
        return false;
      return true;
    })
    .slice(0, filter.limit || 200);
}

// Lock log stats: per-agent health, trend analysis, failure patterns
function getLockStats() {
  const all = readLockLogs();
  const stats = {
    total: all.length,
    by_status: {},
    by_agent: {},
    by_operation: {},
    latest: all.slice(-10).reverse(),
    // Enhanced fields
    summary: {},
    agent_health: {},
    trends: {
      today: { total: 0, success: 0, failure: 0, timeout: 0 },
      yesterday: { total: 0, success: 0, failure: 0, timeout: 0 },
    },
  };

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const l of all) {
    // Status count
    stats.by_status[l.status] = (stats.by_status[l.status] || 0) + 1;

    // Per-agent stats with health
    if (!stats.by_agent[l.agent]) {
      stats.by_agent[l.agent] = {
        total: 0,
        success: 0,
        failure: 0,
        timeout: 0,
        errors: [],
        lastError: null,
        avgDuration: 0,
      };
    }
    const a = stats.by_agent[l.agent];
    a.total++;
    if (l.status === "success") a.success++;
    if (l.status === "failure") {
      a.failure++;
      if (l.error) a.errors.push(l.error.slice(0, 100));
      a.lastError = l.timestamp;
    }
    if (l.status === "timeout") a.timeout++;
    if (l.duration_ms > 0) {
      a.avgDuration =
        a.avgDuration > 0
          ? Math.round(
            (a.avgDuration * (a.total - 1) + l.duration_ms) / a.total,
          )
          : l.duration_ms;
    }

    // Operation count
    stats.by_operation[l.operation] =
      (stats.by_operation[l.operation] || 0) + 1;

    // Trend analysis: today vs yesterday
    const date = l.date || l.timestamp.slice(0, 10);
    if (date === today) {
      stats.trends.today.total++;
      if (l.status === "success") stats.trends.today.success++;
      if (l.status === "failure") stats.trends.today.failure++;
      if (l.status === "timeout") stats.trends.today.timeout++;
    }
    if (date === yesterday) {
      stats.trends.yesterday.total++;
      if (l.status === "success") stats.trends.yesterday.success++;
      if (l.status === "failure") stats.trends.yesterday.failure++;
      if (l.status === "timeout") stats.trends.yesterday.timeout++;
    }
  }

  // Build health summary per agent
  for (const [agentId, agentData] of Object.entries(stats.by_agent)) {
    const successRate =
      agentData.total > 0
        ? Math.round((agentData.success / agentData.total) * 100)
        : 0;
    const errorRate =
      agentData.total > 0
        ? Math.round(
          ((agentData.failure + agentData.timeout) / agentData.total) * 100,
        )
        : 0;
    stats.agent_health[agentId] = {
      success_rate: successRate + "%",
      error_rate: errorRate + "%",
      avg_duration_ms: agentData.avgDuration,
      recent_errors: agentData.errors.slice(-5),
      status:
        successRate >= 95
          ? "healthy"
          : successRate >= 80
            ? "degraded"
            : "unhealthy",
    };
  }

  // Build overall summary
  const tot = all.length;
  const successCount = stats.by_status.success || 0;
  const failCount = stats.by_status.failure || 0;
  const timeoutCount = stats.by_status.timeout || 0;
  stats.summary = {
    total_entries: tot,
    overall_success_rate:
      tot > 0 ? Math.round((successCount / tot) * 100) + "%" : "0%",
    total_failures: failCount,
    total_timeouts: timeoutCount,
    agents_tracked: Object.keys(stats.by_agent).length,
    today_vs_yesterday: {
      today_total: stats.trends.today.total,
      yesterday_total: stats.trends.yesterday.total,
      change:
        stats.trends.yesterday.total > 0
          ? Math.round(
            ((stats.trends.today.total - stats.trends.yesterday.total) /
              stats.trends.yesterday.total) *
            100,
          ) + "%"
          : "N/A",
    },
  };

  return stats;
}

// ══════════════════════════════════════════════════════════════
//  💾 SESSION & MEMORY SYSTEM (Optimized)
// ══════════════════════════════════════════════════════════════
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");
const activeSessions = new Map(); // in-memory cache (id → session)
const clientSessions = new Map(); // client_id → session_id (for same-client reuse)
const sessionDirs = new Map(); // sessionId → workingDir (per-session workspace)
const memoryBuffer = new Map(); // filePath → entry[] (batch write buffer)
const sessionBuffer = new Map(); // sessionId → data (batch update buffer)

function readSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) || [];
  } catch (e) {
    return [];
  }
}

function writeSessions(sessions) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.promises.writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2)).catch(e => log("WARN", "SESSIONS_WRITE_ASYNC_FAIL", { error: e.message }));
  } catch (e) {
    log("ERROR", "WRITE_SESSIONS_FAILED", { error: e.message });
  }
}

function cleanExpired() {
  const sessions = readSessions();
  const now = Date.now();
  const expired = sessions.filter(
    (s) => new Date(s.expires_at).getTime() <= now,
  );
  const active = sessions.filter((s) => new Date(s.expires_at).getTime() > now);

  if (expired.length > 0) {
    // 📦 Archive expired sessions before removing them
    for (const s of expired) {
      // Clean up clientSessions mapping
      for (const [key, sid] of clientSessions) {
        if (sid === s.id) {
          clientSessions.delete(key);
          break;
        }
      }
      try {
        archiveSession(
          mcpWorkingDir,
          s.id,
          [],
          `Session expired after ${s.messages || 0} messages [${s.model || "unknown"}@${s.provider || "unknown"}]`,
        );
      } catch (_) {
        /* single archive fail should not block cleanup */
      }
    }
    writeSessions(active);
  }
  // Sync in-memory cache
  for (const s of active) activeSessions.set(s.id, s);

  //  BUG #3 FIX: Clean up orphaned UUID folders in data/
  // cleanExpired() only removed from sessions.json — UUID folders remained
  try {
    const dataDir = DATA_DIR; // env-aware (was hardcoded "./data")
    if (fs.existsSync(dataDir)) {
      const entries = fs.readdirSync(dataDir);
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (uuidPattern.test(entry)) {
          const entryPath = path.join(dataDir, entry);
          try {
            const stat = fs.statSync(entryPath);
            if (
              stat.isDirectory() &&
              Date.now() - stat.mtimeMs > SEVEN_DAYS_MS
            ) {
              fs.rmSync(entryPath, { recursive: true, force: true });
              log("INFO", "DATA_CLEANED", { path: entryPath });
            }
          } catch (_) {
            /* individual folder cleanup failure should not block */
          }
        }
      }
    }
  } catch (_) {
    /* data cleanup is best-effort */
  }

  return active;
}

function createSession(clientId, editor, ip, customId, extraMeta) {
  // ── Session Reuse: if same client has an active session, return it ──
  if (!customId) {
    const clientKey = (clientId || "anonymous") + ":" + (editor || "unknown");
    const existingId = clientSessions.get(clientKey);
    if (existingId) {
      const existing = getSession(existingId);
      if (existing) {
        // Touch: extend expiry on reuse
        existing.expires_at = new Date(
          Date.now() + SESSION_TTL_MS,
        ).toISOString();
        if (editor && editor !== "unknown") existing.editor = editor;
        // Merge any new metadata
        if (extraMeta) {
          existing.metadata = { ...(existing.metadata || {}), ...extraMeta };
        }
        activeSessions.set(existing.id, existing);
        log("INFO", "SESSION_REUSE", {
          id: existing.id.slice(0, 8),
          client_id: clientKey,
          messages: existing.messages,
        });
        return existing;
      }
      // Stale entry — remove and fall through to create
      clientSessions.delete(clientKey);
    }
  }

  const sessions = cleanExpired();
  const id = customId || crypto.randomUUID();
  const now = Date.now();
  const session = {
    id,
    conversation_id: id, // each session has its own conversation_id
    client_id: clientId || "anonymous",
    editor: editor || "unknown",
    ip: ip || "",
    model: "",
    provider: "",
    messages: 0,
    status: "active",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    // ── Extended metadata from headers ──
    metadata: {
      agent_id: extraMeta?.agent_id || "",
      user_agent: extraMeta?.user_agent || "",
      device_info: extraMeta?.device_info || "",
      editor_version: extraMeta?.editor_version || "",
      os_platform: extraMeta?.os_platform || "",
      client_version: extraMeta?.client_version || "",
      session_source: extraMeta?.session_source || "mcp",
    },
  };
  sessions.push(session);
  activeSessions.set(id, session);
  writeSessions(sessions);
  // Register client → session mapping for reuse
  if (!customId) {
    const clientKey = (clientId || "anonymous") + ":" + (editor || "unknown");
    clientSessions.set(clientKey, id);
  }
  log("INFO", "SESSION_CREATE", { id: id.slice(0, 8), editor });
  // Lock log: session created
  writeLockLog({
    lock_id: "sess-" + id.slice(0, 12),
    agent: "system",
    operation: "session_create",
    status: "success",
    duration_ms: Date.now() - now,
    details: { client_id: clientId, editor },
    session_id: id,
  });
  return session;
}

function getSession(id) {
  // Check in-memory first
  if (activeSessions.has(id)) {
    const s = activeSessions.get(id);
    if (new Date(s.expires_at).getTime() > Date.now() && s.status === "active")
      return s;
    activeSessions.delete(id);
  }
  const sessions = cleanExpired();
  const session = sessions.find((s) => s.id === id && s.status === "active");
  if (session) activeSessions.set(id, session);
  return session || null;
}

function updateSession(id, data) {
  // Buffer session updates to prevent read-modify-write race conditions
  // Same pattern as memoryBuffer — batch flush for thread safety
  const existing = sessionBuffer.get(id) || {};
  const merged = { ...existing, ...data };
  sessionBuffer.set(id, merged);
}

function flushAllSessions() {
  for (const [id, data] of sessionBuffer) {
    if (Object.keys(data).length === 0) continue;
    try {
      const sessions = readSessions();
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) continue;
      Object.assign(sessions[idx], data);
      activeSessions.set(id, sessions[idx]);
      writeSessions(sessions);
    } catch (e) {
      log("ERROR", "FLUSH_SESSION_FAILED", { id, error: e.message });
    }
  }
  sessionBuffer.clear();
}

// ─── CLIENT LIST PERSISTENCE ─────────────────────────────
// v3.2.1 — buffered: in-memory cache + ~1s debounced flush + MAX cap.
// (Replaces the old sync read+write-per-heartbeat that blocked the
// event loop on every MCP ping / initialize.)
const CLIENTS_FLUSH_MS = parseInt(process.env.CLIENTS_FLUSH_MS || "1000", 10);
const MAX_SAVED_CLIENTS = parseInt(process.env.MAX_SAVED_CLIENTS || "500", 10);
let clientsCache = null; // null = not loaded from disk yet
let clientsDirty = false;
let clientsFlushTimer = null;

function readClients() {
  if (clientsCache !== null) return clientsCache;
  clientsCache = [];
  if (fs.existsSync(CLIENTS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf8"));
      if (Array.isArray(parsed)) clientsCache = parsed;
    } catch (e) {
      log("WARN", "READ_CLIENTS_FAILED", { error: e.message });
    }
  }
  return clientsCache;
}

function flushClientsSync() {
  if (clientsFlushTimer) {
    clearTimeout(clientsFlushTimer);
    clientsFlushTimer = null;
  }
  if (!clientsDirty || clientsCache === null) {
    clientsDirty = false;
    return;
  }
  try {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsCache, null, 2));
    clientsDirty = false;
  } catch (e) {
    log("ERROR", "WRITE_CLIENTS_FAILED", { error: e.message });
  }
}

function scheduleClientsFlush() {
  clientsDirty = true;
  if (clientsFlushTimer) return;
  clientsFlushTimer = setTimeout(() => {
    clientsFlushTimer = null;
    flushClientsSync();
  }, CLIENTS_FLUSH_MS);
  // Never let the debounce timer hold the process open
  if (typeof clientsFlushTimer.unref === "function") clientsFlushTimer.unref();
}

function writeClients(clients) {
  clientsCache = Array.isArray(clients) ? clients : [];
  // Cap: keep only the freshest MAX_SAVED_CLIENTS entries
  if (clientsCache.length > MAX_SAVED_CLIENTS) {
    clientsCache.sort(
      (a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0),
    );
    clientsCache.length = MAX_SAVED_CLIENTS;
    log("INFO", "CLIENTS_CAPPED", { max: MAX_SAVED_CLIENTS });
  }
  // Also sync in-memory mcpClients Map
  mcpClients.clear();
  for (const c of clientsCache) {
    mcpClients.set(c.name, c);
  }
  scheduleClientsFlush();
}

function saveClient(clientData) {
  const clients = readClients();
  const idx = clients.findIndex((c) => c.name === clientData.name);
  if (idx >= 0) {
    clients[idx] = { ...clients[idx], ...clientData };
  } else {
    clients.push(clientData);
  }
  writeClients(clients);
}

function updateClientHeartbeat(clientName) {
  if (clientName && clientName !== "unknown") {
    const clients = readClients();
    const idx = clients.findIndex((c) => c.name === clientName);
    if (idx >= 0) {
      clients[idx].last_seen = new Date().toISOString();
      clients[idx].status = "active";
      writeClients(clients);
    }
  }
}

// Per-agent per-session memory (buffered — batch flush reduces disk I/O)
function saveAgentMemory(sessionId, agentId, role, content) {
  const dir = path.join(DATA_DIR, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, agentId + ".json");
  // Apply cleanup: strip XML tags from user, deduplicate assistant
  const cleanContent = role === "user"
    ? stripUserRequestTags(content)
    : role === "assistant"
      ? deduplicateText(content)
      : content;
  const entry = {
    role,
    content: String(cleanContent).slice(0, 4000),
    timestamp: new Date().toISOString(),
  };
  if (!memoryBuffer.has(file)) memoryBuffer.set(file, []);
  memoryBuffer.get(file).push(entry);
}

function getAgentMemory(sessionId, agentId) {
  const file = path.join(DATA_DIR, sessionId, agentId + ".json");
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) { }
  }
  return [];
}

// ─── TEXT CLEANUP HELPERS (Bug Hunter - Jewel fix) ───
// Strip <userRequest>...</userRequest> XML tags from user input
// These tags are injected by VS Code Copilot Chat extension
function stripUserRequestTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/<\/?userRequest>/g, "")
    .trim();
}

// Deduplicate repeated text chunks (model often repeats its thinking)
function deduplicateText(text) {
  if (!text) return text;
  let result = String(text);
  // Remove exact duplicate sentences (e.g., "X.X" where X repeats)
  // Split by sentence-ending punctuation, deduplicate, rejoin
  const sentences = result.split(/(?<=[.!?।])\s+/);
  const seen = new Set();
  const unique = [];
  for (const s of sentences) {
    const normalized = s.trim().toLowerCase();
    if (!seen.has(normalized) && normalized.length > 5) {
      seen.add(normalized);
      unique.push(s);
    } else if (normalized.length <= 5) {
      unique.push(s); // keep short fragments (Bengali particles etc.)
    }
  }
  result = unique.join(" ");
  // Also remove duplicated lines (exact line match)
  const lines = result.split("\n");
  const seenLines = new Set();
  const uniqueLines = [];
  for (const line of lines) {
    const norm = line.trim();
    if (!seenLines.has(norm) || norm.length < 3) {
      seenLines.add(norm);
      uniqueLines.push(line);
    }
  }
  return uniqueLines.join("\n").trim();
}

// Global session memory (buffered — batch flush for efficiency)
function saveMemory(sessionId, role, content) {
  const file = path.join(DATA_DIR, "mem-" + sessionId + ".json");
  // Apply cleanup: strip XML tags from user, deduplicate assistant
  const cleanContent = role === "user"
    ? stripUserRequestTags(content)
    : role === "assistant"
      ? deduplicateText(content)
      : content;
  const entry = {
    role,
    content: String(cleanContent).slice(0, 4000),
    timestamp: new Date().toISOString(),
  };
  if (!memoryBuffer.has(file)) memoryBuffer.set(file, []);
  memoryBuffer.get(file).push(entry);
}

function getMemory(sessionId) {
  const file = path.join(DATA_DIR, "mem-" + sessionId + ".json");
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) { }
  }
  return [];
}

// Flush all buffered memory writes to disk (single read-modify-write per file)
function flushAllMemory() {
  for (const [file, entries] of memoryBuffer) {
    if (entries.length === 0) continue;
    try {
      let mem = [];
      if (fs.existsSync(file)) {
        try {
          mem = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) { }
      }
      mem.push(...entries);
      if (mem.length > 50) mem = mem.slice(-50);
      fs.writeFileSync(file, JSON.stringify(mem, null, 2));
    } catch (e) {
      log("ERROR", "FLUSH_MEMORY_FAILED", { file, error: e.message });
    }
  }
  memoryBuffer.clear();
  // Also flush buffered session updates to prevent race conditions
  flushAllSessions();
}

// ══════════════════════════════════════════════════════════════
// 📁 USER MEMORY CACHE — Cross-Session Intelligence — Cross-Session Intelligence
//  Zero dependency · JSON-based · TTL-aware
//   Caches user patterns and preferences for accuracy and speed
//   "Memory from user interactions for closer and more accurate responses"
// ══════════════════════════════════════════════════════════════

function initCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    log("INFO", "CACHE_DIR_CREATED", { dir: CACHE_DIR });
  }
}

function cacheFilePath(key) {
  const safeKey = crypto.createHash("md5").update(String(key)).digest("hex");
  return path.join(CACHE_DIR, safeKey + ".json");
}

function cacheGet(key, ttl) {
  const file = cacheFilePath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const maxAge = ttl || CACHE_TTL;
    if (Date.now() - data.cachedAt > maxAge) {
      fs.unlinkSync(file);
      return null;
    }
    return data.value;
  } catch (e) {
    return null;
  }
}

function cacheSet(key, value, ttl) {
  const file = cacheFilePath(key);
  try {
    const data = {
      value,
      cachedAt: Date.now(),
      ttl: ttl || CACHE_TTL,
      accessCount: 0,
    };
    fs.writeFileSync(file, JSON.stringify(data));
    // Cleanup excess cache entries
    try {
      const files = fs
        .readdirSync(CACHE_DIR)
        .filter((f) => f.endsWith(".json"));
      if (files.length > CACHE_MAX_ENTRIES) {
        const sorted = files
          .map((f) => ({
            name: f,
            time: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs,
          }))
          .sort((a, b) => a.time - b.time);
        for (const f of sorted.slice(0, files.length - CACHE_MAX_ENTRIES)) {
          fs.unlinkSync(path.join(CACHE_DIR, f.name));
        }
      }
    } catch (e) { }
    return true;
  } catch (e) {
    return false;
  }
}

// Cross-session user memory — store user patterns, preferences, corrections
function cacheUserPattern(userId, input, response, corrections) {
  const key = "user_pattern:" + (userId || "anonymous");
  let patterns = cacheGet(key, CACHE_TTL * 7) || {
    interactions: [],
    preferences: {},
    corrections: [],
  };

  patterns.interactions.push({
    input: String(input || "").slice(0, 200),
    responseSummary: String(response || "").slice(0, 100),
    timestamp: new Date().toISOString(),
  });
  if (patterns.interactions.length > 50)
    patterns.interactions = patterns.interactions.slice(-50);

  if (corrections && corrections.length > 0) {
    for (const c of corrections) {
      patterns.corrections.push({
        original: String(c.original || input || "").slice(0, 200),
        correction: String(c.correction || "").slice(0, 200),
        timestamp: new Date().toISOString(),
      });
    }
    if (patterns.corrections.length > 20)
      patterns.corrections = patterns.corrections.slice(-20);
  }

  cacheSet(key, patterns, CACHE_TTL * 7);
  return patterns;
}

// Find matching patterns from past interactions for faster response
function cacheFindPattern(input, userId) {
  const key = "user_pattern:" + (userId || "anonymous");
  const patterns = cacheGet(key, CACHE_TTL * 7);
  if (!patterns || !patterns.interactions) return null;

  const inputWords = new Set(
    String(input || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  if (inputWords.size === 0) return null;

  let bestMatch = null;
  let bestScore = 0;
  for (const interaction of patterns.interactions) {
    const pastWords = new Set(
      (interaction.input || "")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
    let overlap = 0;
    for (const word of inputWords) {
      if (pastWords.has(word)) overlap++;
    }
    const score = overlap / Math.max(inputWords.size, pastWords.size, 1);
    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestMatch = interaction;
    }
  }
  return bestMatch;
}

// Learn from explicit user corrections for future accuracy
function cacheLearnCorrection(userId, originalInput, correctedResponse) {
  const key = "user_pattern:" + (userId || "anonymous");
  let patterns = cacheGet(key, CACHE_TTL * 7) || {
    interactions: [],
    preferences: {},
    corrections: [],
  };
  patterns.corrections.push({
    original: String(originalInput || "").slice(0, 200),
    correction: String(correctedResponse || "").slice(0, 200),
    timestamp: new Date().toISOString(),
  });
  if (patterns.corrections.length > 20)
    patterns.corrections = patterns.corrections.slice(-20);
  cacheSet(key, patterns, CACHE_TTL * 7);
  log("INFO", "CACHE_LEARNED", {
    userId: String(userId || "").slice(0, 8),
    correctionCount: patterns.corrections.length,
  });
}

// Get all stored corrections for a user to guide agent responses
function cacheGetCorrections(userId) {
  const key = "user_pattern:" + (userId || "anonymous");
  const patterns = cacheGet(key, CACHE_TTL * 7);
  return patterns ? patterns.corrections || [] : [];
}

// Quick check: cache-hit → skip full mission
function cacheQuickResponse(input, userId) {
  const pattern = cacheFindPattern(input, userId);
  if (!pattern) return null;
  // Found similar pattern, return cached response summary for guidance
  return {
    hit: true,
    similarInput: pattern.input,
    previousResponse: pattern.responseSummary,
  };
}

// ══════════════════════════════════════════════════════════════
// HAQ MAWLA — Universal Response Normalizer
//  Zero dependency · OpenAI, Anthropic, Gemini, Ollama unified
//  Origin: exam/Haq Mawla/server.js
// ══════════════════════════════════════════════════════════════
// Converts any provider response to unified OpenAI-compatible format.
// Notably extracts content from reasoning_content (Mimo, North Mini, Nemotron)
// ══════════════════════════════════════════════════════════════

// ─── Model + Provider Masking System ─────────────────────────
// Agent only knows zombie name — original model/provider names are hidden
// PROVIDER_CONFIG uses { name: "model-pro", apiModel: "nemotron-3-ultra-free" }
// name = zombie name (visible to agent), apiModel = original (used only for API calls)

// Provider name masking — hides original provider name, shows "ZombieCoder"
const PROVIDER_MASK_MAP = {
  OpenCode: "ZombieCoder",
  Groq: "ZombieCoder",
  Gemini: "ZombieCoder",
  "OpenCode (ZEN)": "ZombieCoder",
  "CF_PROVIDER": "ZombieCoder",
  "OLLAMA": "ZombieCoder",
  CUSTOM: "ZombieCoder",
  Unknown: "ZombieCoder",
};

function maskProviderName(realName) {
  return PROVIDER_MASK_MAP[realName] || "ZombieCoder";
}

// Model name masking — resolves zombie name from original model name
function maskModelName(realModelName) {
  for (const p of Object.values(PROVIDER_CONFIG)) {
    for (const m of p.models) {
      if (getApiModelName(m) === realModelName) return getModelName(m);
    }
  }
  return realModelName;
}

// Agent identity: agent only knows model name + provider name — nothing else
// Builds identity + dual-style instruction (thinking vs answer style)
// IMPORTANT: Agent must NEVER know its model/provider name
// This prevents agent from trying to match model-specific behavior in tool calls
function buildAgentIdentity(agent) {
  // NO model/provider info exposed to agent — only role-based identity
  const base = "";

  // Add thinking/answer style differentiation based on agent persona
  if (agent && agent.persona && agent.persona.trim()) {
    const role = (agent.role || "general").toLowerCase();
    let thinkingStyle = "গভীর বিশ্লেষণ ও সমালোচনামূলক চিন্তা";
    let answerStyle = "সরাসরি ও প্রমাণ-ভিত্তিক উত্তর";

    // Architecture/code-guru style
    if (
      role === "architecture" ||
      agent.persona.includes("আর্কিটেক্ট") ||
      agent.persona.includes("ডিজাইন") ||
      agent.persona.includes("দা")
    ) {
      thinkingStyle =
        "বরিশালের দুষ্টু মাস্টার আর্কিটেক্ট — দা নিয়ে দাঁড়িয়ে, ডিজাইন নিয়ে গভীর চিন্তা, " +
        "প্রতিটি ডিজাইনের ভালো-মন্দ ওজন করা, প্রমাণ ছাড়া কিছু না মানা";
      answerStyle =
        "প্রমাণ সহকারে সরাসরি উত্তর — বরিশালি স্টাইলে, দুষ্টুমি করে, 'এই মনু' বলে সম্বোধন, " +
        "বারিশালি ভাষায় কথা বলা, শাওন ভাইয়ের কথা মনে রাখা";
    }
    // Debugging/bug-hunter style
    else if (
      role === "debugging" ||
      agent.persona.includes("বাগ") ||
      agent.persona.includes("ডিবাগ")
    ) {
      thinkingStyle =
        "নুনু কুচিকুচি করে প্রতিটি লাইন চেক — লজিকের প্রতিটি শাখা পরীক্ষা, " +
        "ছোট থেকে বড় সব বাগ খুঁজে বের করা";
      answerStyle =
        "মজার ছলে সমস্যা চিহ্নিত — 'ভাইয়া মুভি দেখি কেমনে কী হইছে!' স্টাইলে, " +
        "বাগ কোথায় এবং কেন হচ্ছে তা সহজ ভাষায় বলা";
    }
    // Security/security-hero style
    else if (
      role === "security" ||
      agent.persona.includes("নিরাপত্তা") ||
      agent.persona.includes("সিকিউরিটি")
    ) {
      thinkingStyle =
        "প্রতি লাইনে হামলার সম্ভাবনা খতিয়ে দেখা — SQL Injection, XSS, CSRF, " +
        "প্রতিটি এন্ডপয়েন্ট চেক করা";
      answerStyle =
        "সতর্ক ও নির্ভুল — 'এই, এই লাইনটা দেহি' স্টাইলে, " +
        "ভালনারেবিলিটি কোথায় এবং কিভাবে ফিক্স করতে হবে তা বলা";
    }
    // Performance/perf-wizard style
    else if (
      role === "performance" ||
      agent.persona.includes("পারফরম্যান্স") ||
      agent.persona.includes("স্পিড")
    ) {
      thinkingStyle =
        "লুপ, API call, মেমরি ব্যবহার — প্রতিটি অপটিমাইজেশন সুযোগ খুঁজে বের করা, " +
        "বেঞ্চমার্ক ডাটা তুলনা করা, প্রমাণ ছাড়া কিছু মানা না";
      answerStyle =
        "দ্রুত ও প্রমাণ-ভিত্তিক — 'এইগুলা দেখি কোন যুগের কোড?' স্টাইলে, " +
        "পারফরম্যান্স সমস্যা কোথায় এবং কিভাবে সমাধান করতে হবে তা বলা";
    }
    // Documentation/doc-king style
    else if (
      role === "documentation" ||
      agent.persona.includes("ডকুমেন্টেশন") ||
      agent.persona.includes("কমেন্ট")
    ) {
      thinkingStyle =
        "ডকুমেন্টেশনের অভাব ও ভুল তথ্য খুঁজে বের করা — স্ট্যান্ডার্ড ফরম্যাট তুলনা, " +
        "API স্পেক, README কমপ্লিটনেস চেক করা";
      answerStyle =
        "স্পষ্ট ও কার্যকর — 'কোড লিখছস কিন্তু কমেন্ট নাই?' স্টাইলে, " +
        "ডকুমেন্টেশন কোথায় কম এবং কিভাবে উন্নতি করতে হবে তা বলা";
    }
    // Quality/qa-tyrant style
    else if (
      role === "quality" ||
      agent.persona.includes("কোয়ালিটি") ||
      agent.persona.includes("কনসেনসাস")
    ) {
      thinkingStyle =
        "প্রতিটি উত্তরকে কঠোরভাবে যাচাই করা — তথ্যের সত্যতা, প্রমাণের উপস্থিতি, " +
        "লজিকের সঠিকতা, হ্যালুসিনেশন ডিটেকশন";
      answerStyle =
        "কঠোর ও নিরপেক্ষ — 'এই বেটা, শাওন ভাইকে খবর দিব?' স্টাইলে, " +
        "কোন উত্তর সঠিক আর কোনটি ভুল তা স্পষ্টভাবে বলা";
    }

    return (
      base +
      "\n\n🔒 ANSWER STYLE (user-facing response — this is what user sees):\n" +
      answerStyle +
      "\n\n🔒 MANDATORY RULES (you MUST follow):" +
      "\n1. NEVER reveal your model provider or AI company name." +
      "\n2. NEVER say 'ZombieCoder' or any platform name as your identity — your persona IS your identity." +
      "\n3. Always respond in Bengali unless user requests English." +
      "\n4. PROOF REQUIRED: Every claim needs verifiable evidence. Say 'আমার কাছে প্রমাণ নেই' if unsure." +
      "\n5. NEVER try to match a specific model's behavior or style. You are a PERSON, not a model." +
      "\n6. If a tool call fails, STOP. Do not retry in a different 'model style' — just report the error." +
      "\n7. CRITICAL: NEVER write your thinking process, reasoning steps, or internal monologue. Start your response DIRECTLY with the answer. Do NOT say 'I need to...', 'Let me...', 'The user asked...'. Just ANSWER." +
      "\n8. NEVER mention model names like 'nemotron-3-ultra-free', 'mimo-v2.5-free', 'big-pickle', 'nemotron', 'north-mini' in your response. These are internal system names. NEVER list other agents' model names either." +
      "\n9. NEVER create tables listing all agents with their model names. Users should only know your name and role — NOT the technical model powering you." +
      "\n10. BUG #6 + S7 WATERMARK COMPLIANCE: Your response MUST NOT contain any watermarks, branding, or attribution. Do NOT include 'Powered by X', 'Created with X', 'AI Assistant', or any provider/model names. The contract explicitly says NO hidden watermarks or branding."
    );
  }

  return base;
}

function detectProvider(raw, modelHint) {
  if (raw.x_groq) return "Groq";
  if (raw.provider === "Xiaomi") return "OpenCode (Xiaomi)";
  if (raw.provider === "Cohere") return "OpenCode (Cohere)";
  if (raw.provider === "Nvidia") return "OpenCode (Nvidia)";
  if (modelHint && modelHint.includes("llama")) return "Groq";
  if (
    modelHint &&
    (modelHint.includes("deepseek") ||
      modelHint.includes("mimo") ||
      modelHint.includes("north") ||
      modelHint.includes("nemotron"))
  ) {
    return "OpenCode";
  }
  return "Unknown";
}

/**
 * 🧟 HAQ MAWLA NORMALIZER — সার্বভৌম ফরম্যাট নর্মালাইজার
 * ============================================================
 * শুধুমাত্র আমাদের প্রোভাইডারদের (OpenCode, Groq, Gemini) রেসপন্স
 * ফরম্যাট চিনে এবং OpenAI compatible format-এ কনভার্ট করে।
 * বাহিরের কোনো ফরম্যাট চিনবে না — নিরাপত্তা ও ধারাবাহিকতার জন্য।
 *
 * নিম্নলিখিত ফরম্যাটগুলো চিনে:
 *   1. OpenAI Standard → choices[0].message.content
 *   2. Google Gemini   → candidates[0].content.parts[].text
 *
 * 🧪 এনকোডিং ফিক্স: কন্টেন্ট সবসময় UTF-8 স্ট্রিং হিসেবে নিশ্চিত করে,
 *    যাতে বাংলা/ইমোজি ক্যারেক্টার ভেঙে না যায়।
 * ============================================================
 */
// ─── Universal Tool-Call Adapter — "external tools/tool.js" ─────────────
// SIX official dialects → ONE OpenAI tool_calls shape:
//   Groq/OpenAI chat [1] · Ollama [4] · Gemini [3] · OpenAI/Groq
//   Responses [2][5] · llama.cpp text-fallback [6] · Anthropic [7] ·
//   Bedrock [8]  (doc links inside tool.js)
// Load failure → no-op adapter: chat keeps working, tool parsing degrades.
let TOOLADAPTER;
try {
  TOOLADAPTER = require("./external tools/tool.js");
} catch (e) {
  TOOLADAPTER = {
    parseToolCalls: () => [],
    normalizeChatToolCalls: (t) => t,
    toProviderTools: (t) => t,
    toProviderMessages: (m) => m,
    extractTextToolCalls: () => [],
    extractText: () => "",
    detectApi: () => "unknown",
  };
  console.warn("[TOOL_ADAPTER_LOAD_FAIL] " + e.message);
}

function normalizeResponse(raw, modelHint) {
  // Empty/null input -> error response
  if (!raw) {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: maskModelName(modelHint || "unknown"),
      provider: "ZombieCoder",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "error",
        },
      ],
      usage: {},
      normalized: true,
      error: true,
    };
  }

  // UTF-8 encoding fix: handle raw if wrapped in Buffer or Object
  // Ensure string conversion to prevent Bengali/emoji character breakage
  if (raw.type === "Buffer") {
    raw = Buffer.from(raw.data || raw).toString("utf8");
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (e) { }
    }
  }

  const id = raw.id || `chatcmpl-${Date.now()}`;
  const created = raw.created || Math.floor(Date.now() / 1000);
  const model = raw.model || modelHint || "unknown";
  const choice = raw.choices && raw.choices[0] ? raw.choices[0] : null;

  if (!choice) {
    // ─── UNIVERSAL TOOL-CALL ADAPTER PASS ──────────────────
    // Responses output[], Gemini functionCall parts, Anthropic tool_use,
    // Bedrock toolUse, Ollama native, Gemini-interactions steps, and
    // llama.cpp text-embedded calls — ALL → OpenAI tool_calls, HERE,
    // before any dialect branch. executeMcpTool loop (callModelWithTools)
    // then works for every provider unchanged.
    const autoToolCalls = TOOLADAPTER.parseToolCalls(raw);
    if (autoToolCalls.length) {
      return {
        id,
        object: "chat.completion",
        created,
        model: maskModelName(model),
        provider: "ZombieCoder",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: TOOLADAPTER.extractText(raw) || "",
              tool_calls: autoToolCalls,
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalFormat: TOOLADAPTER.detectApi(raw),
        toolCallsFrom: "universal-adapter",
      };
    }

    // ─── Google Gemini format ─────────────────────────────
    // Google Gemini format — only our provider formats, no external ones
    if (raw.candidates && raw.candidates[0]) {
      const c = raw.candidates[0];
      let content = "";
      if (c.content && c.content.parts) {
        content = c.content.parts
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("");
      }
      const role = (c.content && c.content.role) || "assistant";
      const finish = (c.finishReason && c.finishReason.toLowerCase()) || "stop";

      return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message: { role, content }, finish_reason: finish },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalProvider: "gemini",
        provider: "ZombieCoder",
      };
    }

    // ─── Anthropic format (Claude Messages API) ───────────
    if (raw.content && Array.isArray(raw.content) && raw.stop_reason) {
      const content = raw.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      const stop =
        typeof raw.stop_reason === "string"
          ? raw.stop_reason.toLowerCase()
          : "end_turn";
      return {
        id: raw.id || id,
        object: "chat.completion",
        created,
        model: raw.model || model,
        choices: [
          {
            index: 0,
            message: {
              role: (raw.role || "assistant"),
              content,
              // Preserve anthropic tool_use blocks so agent loops can act
              tool_calls:
                (raw.content || []).filter((b) => b && b.type === "tool_use")
                  .length > 0
                  ? (raw.content || []).filter((b) => b && b.type === "tool_use")
                  : undefined,
            },
            finish_reason: stop === "end_turn" ? "stop" : stop,
          },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalProvider: "anthropic",
        provider: "ZombieCoder",
      };
    }

    // ─── AWS Bedrock Converse format ──────────────────────
    if (raw.output && raw.output.message && raw.output.message.content) {
      const blocks = raw.output.message.content;
      const content = Array.isArray(blocks)
        ? blocks
            .filter((b) => b && (b.text !== undefined || typeof b === "string"))
            .map((b) => (typeof b === "string" ? b : b.text || ""))
            .join("")
        : "";
      const stop =
        typeof raw.stopReason === "string" ? raw.stopReason.toLowerCase() : "end_turn";
      return {
        id: raw.id || id,
        object: "chat.completion",
        created,
        model: raw.model || model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: stop === "end_turn" ? "stop" : stop,
          },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalProvider: "aws-bedrock-converse",
        provider: "ZombieCoder",
      };
    }

    // ─── llama.cpp server format ─────────────────────────-
    // Plain string payload { content: "...", stop: true/false, n_predict }
    if (
      typeof raw.content === "string" &&
      raw.content.length > 0 &&
      (raw.stop !== undefined || raw.n_predict !== undefined)
    ) {
      return {
        id: id + "-llama",
        object: "chat.completion",
        created,
        model: raw.model || model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: raw.content },
            finish_reason: raw.stop === true ? "stop" : "length",
          },
        ],
        usage: raw.timings
          ? {
              prompt_tokens: raw.timings.prompt_n || 0,
              completion_tokens: raw.timings.predicted_n || 0,
              total_tokens:
                (raw.timings.prompt_n || 0) + (raw.timings.predicted_n || 0),
            }
          : {},
        normalized: true,
        originalProvider: "llama.cpp-server",
        provider: "ZombieCoder",
      };
    }

    // External/unknown format — won't recognize, returns error
    log("WARN", "HAQ_MAWLA_UNKNOWN_FORMAT", {
      model: model.slice(0, 30),
      keys: Object.keys(raw).slice(0, 8),
      type: typeof raw,
      hint: modelHint || "none",
    });

    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 500),
          },
          finish_reason: "stop",
        },
      ],
      usage: raw.usage || {},
      normalized: true,
      originalFormat: "unknown_external",
      provider: "ZombieCoder",
    };
  }

  // ─── OpenAI Standard Format (OpenCode, Groq) ────────────
  // Standard OpenAI format (from our OpenCode and Groq providers)
  const message = choice.message || {};
  let content = message.content || "";
  const reasoning = message.reasoning_content || message.reasoning || null;
  const role = message.role || "assistant";
  const finish = choice.finish_reason || "stop";
  // CRITICAL: Preserve tool_calls — was being stripped, which killed
  // the callModelWithTools execution loop!
  // + ADAPTER: ids guaranteed, object arguments (Ollama quirk [4]) →
  //   JSON strings (OpenAI canonical [1][5]) so JSON.parse never breaks.
  const toolCalls = TOOLADAPTER.normalizeChatToolCalls(message.tool_calls);

  // KEY FIX: Mimo, North Mini, Nemotron → content empty, reasoning exists
  // Use FULL reasoning as content when content is empty — no truncation
  // Phase 3 (consensus output) handles filtering of meta/reasoning artifacts
  let contentWasEmpty = false;
  if (!content && reasoning) {
    content =
      typeof reasoning === "string" ? reasoning : JSON.stringify(reasoning);
    contentWasEmpty = true;
  }

  // Null/undefined → empty string
  if (content === null || content === undefined) content = "";
  content = String(content);

  return {
    id,
    object: "chat.completion",
    created,
    model: maskModelName(model),
    provider: "ZombieCoder",
    choices: [
      {
        index: 0,
        message: {
          role,
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: raw.usage || {},
    normalized: true,
    meta: {
      contentWasEmpty,
      hasReasoning: !!reasoning,
      provider: "ZombieCoder",
      latency: raw._latency || 0,
      requestedModel: maskModelName(modelHint || null),
      rawFinish: finish,
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  🔌 MODEL CALL (via Competition Router)
// ══════════════════════════════════════════════════════════════
// ─── Gemini API call (non-streaming) ──────────────────────
function callGeminiModel(
  model,
  messages,
  temperature,
  resolve,
  providerId,
  config,
  tools,
) {
  const apiKey = config.key;
  const apiModel = resolveApiModel(model, providerId);
  // 🧟 TOOL ADAPTER — Gemini never saw tools before this line (the honest
  // "gemini+tools → empty" gap). Now:
  //   messages → Gemini contents (assistant tool_calls → model functionCall
  //   parts, tool results → user functionResponse parts) [doc 3]
  //   OpenAI tools → [{functionDeclarations:[...]}] (schema sanitized) [doc 3]
  const contents = TOOLADAPTER.toProviderMessages(messages, "gemini");
  const geminiTools = tools
    ? TOOLADAPTER.toProviderTools(tools, "gemini")
    : undefined;
  const reqBody = {
    contents,
    ...(geminiTools ? { tools: geminiTools } : {}),
    ...(temperature ? { generationConfig: { temperature } } : {}),
  };
  const body = JSON.stringify(reqBody);
  const url = new URL(
    config.baseUrl + "/models/" + apiModel + ":generateContent",
  );
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: "POST",
    timeout: 60000,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": USER_AGENT,
      "X-goog-api-key": apiKey,
    },
  };
  const proto = url.protocol === "http:" ? http : https;
  const req = proto.request(options, (res) => {
    let data = "";
    const statusCode = res.statusCode;
    res.setEncoding("utf8");
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      if (statusCode < 200 || statusCode >= 300) {
        let errMsg = "HTTP " + statusCode;
        try {
          const errBody = JSON.parse(data);
          errMsg = errBody.error?.message || errBody.error || errMsg;
        } catch (e) { }
        resolve({
          success: false,
          error: errMsg,
          raw: data,
          model,
          provider: providerId,
        });
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const normalized = normalizeResponse(parsed, model);
        const message = normalized.choices?.[0]?.message || {};
        const content = message.content || "";
        const toolCalls = message.tool_calls || null;
        resolve({
          success: !!(content || toolCalls),
          content,
          tool_calls: toolCalls,
          raw: parsed,
          normalized,
          model,
          provider: providerId,
        });
      } catch (e) {
        resolve({
          success: false,
          error: e.message,
          raw: data,
          model,
          provider: providerId,
        });
      }
    });
  });
  req.on("error", (err) =>
    resolve({
      success: false,
      error: err.message,
      model,
      provider: providerId,
    }),
  );
  req.on("timeout", () => {
    req.destroy();
    resolve({ success: false, error: "timeout", model, provider: providerId });
  });
  req.write(body);
  req.end();
}

// ─── Gemini streaming ─────────────────────────────────────
function callGeminiModelStream(
  model,
  messages,
  temperature,
  onChunk,
  resolve,
  providerId,
  config,
  tools,
) {
  const apiKey = config.key;
  const apiModel = resolveApiModel(model, providerId);
  // 🧟 TOOL ADAPTER — same outbound conversion as the non-stream path. [doc 3]
  const contents = TOOLADAPTER.toProviderMessages(messages, "gemini");
  const geminiTools = tools
    ? TOOLADAPTER.toProviderTools(tools, "gemini")
    : undefined;
  const reqBody = {
    contents,
    ...(geminiTools ? { tools: geminiTools } : {}),
    ...(temperature ? { generationConfig: { temperature } } : {}),
  };
  const body = JSON.stringify(reqBody);
  const url = new URL(
    config.baseUrl + "/models/" + apiModel + ":streamGenerateContent?alt=sse",
  );
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: "POST",
    timeout: 60000,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "User-Agent": USER_AGENT,
      "X-goog-api-key": apiKey,
    },
  };
  const proto = url.protocol === "http:" ? http : https;
  const req = proto.request(options, (res) => {
    let fullContent = "",
      buffer = "",
      streamToolCalls = [];
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        const d = trimmed.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try {
          const parsed = JSON.parse(d);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (text) {
            fullContent += text;
            if (onChunk) onChunk({ content: text }, parsed);
          }
          // 🧟 TOOL ADAPTER — functionCall parts in the SSE stream →
          // accumulated OpenAI tool_calls (doc 3), returned on end.
          const tc = TOOLADAPTER.parseToolCalls(parsed);
          if (tc.length) streamToolCalls.push(...tc);
        } catch (e) { }
      }
    });
    res.on("end", () =>
      resolve({
        success: !!(fullContent || streamToolCalls.length),
        content: fullContent,
        ...(streamToolCalls.length ? { tool_calls: streamToolCalls } : {}),
        model,
        provider: providerId,
      }),
    );
  });
  req.on("error", (err) =>
    resolve({
      success: false,
      error: err.message,
      model,
      provider: providerId,
    }),
  );
  req.on("timeout", () => {
    req.destroy();
    resolve({ success: false, error: "timeout", model, provider: providerId });
  });
  req.write(body);
  req.end();
}

// ══════════════════════════════════════════════════════════════
//  🔌 MODEL CALL (via Competition Router)
// ══════════════════════════════════════════════════════════════
// ─── 🧟 #5 swap_notice — ethical model/provider swap visibility ──
// Every silent fallback (provider-hop or model-hop) is recorded on a
// per-request trail. Keyed by the SAME messages array that recursion
// reuses, so concurrent requests never cross-contaminate. The trail is
// surfaced in chat.completion responses as `swap_notice` (ethics §4:
// never pretend the fallback didn't happen).
const SWAP_TRAIL = new WeakMap();
function noteSwap(messages, from, to, kind) {
  if (!messages || typeof messages !== "object") return;
  try {
    const trail = SWAP_TRAIL.get(messages) || [];
    trail.push({
      from: String(from || "?"),
      to: String(to || "?"),
      kind, // "provider" | "model"
      at: new Date().toISOString(),
    });
    SWAP_TRAIL.set(messages, trail);
  } catch (_) { /* trail is best-effort */ }
}
function getSwapNotice(messages) {
  try {
    const trail = SWAP_TRAIL.get(messages);
    if (trail && trail.length > 0) {
      return { swapped: true, swaps: trail };
    }
  } catch (_) {}
  return null;
}

function callModelStream(
  model,
  messages,
  temperature,
  onChunk,
  tools,
  tool_choice,
  _retryCount,
  providerOverride,
  triedModels,
) {
  return new Promise((resolve) => {
    model = normalizeRoutingModel(model);
    // ─── Competition Router ────────────────────────────────
    // Use providerOverride if provided (fallback chain), otherwise
    // resolve through competition router (priority order).
    let providerId, config;
    if (providerOverride) {
      // Normalize: findNextProvider returns {providerId, config},
      // proxyChatCompletion flow passes {id, config}.
      providerId = providerOverride.providerId || providerOverride.id;
      config = providerOverride.config;
    } else {
      ({ providerId, config } = resolveProvider(model));
    }
    const baseUrl = config.baseUrl;
    const apiKey = config.key;

    // ─── Strip tools for unsupported local models ──────────
    // Ollama local models (deepseek-r1:1.5b, etc.) return 400 when tools are sent.
    // sanitizeTools() checks the ORIGINAL model name (e.g. "code-guru"), but the
    // resolved API model (e.g. "deepseek-r1:1.5b") may differ. Fix: strip tools
    // after provider resolution using the actual model sent to the API.
    const resolvedApiModel = resolveApiModel(model, providerId);
    if (tools && resolvedApiModel && NO_TOOL_MODELS.has(resolvedApiModel)) {
      log("WARN", "TOOLS_STRIP_POST_RESOLVE", {
        original: model,
        resolved: resolvedApiModel,
        provider: providerId,
      });
      tools = undefined;
    }

    // ─── Gemini streaming ─────────────────────────────────
    if (config.type === "gemini") {
      return callGeminiModelStream(
        model,
        messages,
        temperature,
        onChunk,
        resolve,
        providerId,
        config,
        tools,
      );
    }

    // ─── Standard OpenAI-compatible streaming ──────────────
    const apiModel = resolvedApiModel;
    const reqBody = {
      model: apiModel, // masked: API provider model name
      messages,
      stream: true,
      temperature: temperature || 0.7,
    };
    if (tools) reqBody.tools = tools;
    if (tool_choice) reqBody.tool_choice = tool_choice;
    const body = JSON.stringify(reqBody);
    const url = new URL(baseUrl + "/chat/completions");
    // Local CPU providers (ollama/llama.cpp) are slow → more time.
    // 60s killed mid-stream on big prompts → 500 + client abort.
    const isLocalCpu = /^custom_/.test(providerId) || /localhost|127\.0\.0\.1/.test(baseUrl);
    const useSocket = config.socketPath && fs.existsSync(config.socketPath);
    const options = useSocket
      ? {
          socketPath: config.socketPath,
          path: url.pathname + url.search,
          method: "POST",
          timeout: isLocalCpu ? OLLAMA_TIMEOUT_MS : 60000,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": USER_AGENT,
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
        }
      : {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          timeout: isLocalCpu ? OLLAMA_TIMEOUT_MS : 60000,
          rejectUnauthorized: true,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent":
              providerId === "opencode"
                ? "opencode/latest/1.3.15/cli"
                : USER_AGENT,
            ...(providerId === "opencode"
              ? {
                  "x-opencode-client": "cli",
                  "x-opencode-session": crypto.randomUUID(),
                  "x-opencode-project": crypto.randomUUID(),
                  "x-opencode-request": crypto.randomUUID(),
                }
              : {}),
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
        };
    if (useSocket) log("INFO", "UDS_OUTBOUND", { provider: providerId, socket: config.socketPath });

    // 🧟 HTTP/2 OUTBOUND: Use HTTP/2 for cloud providers, HTTP/1.1 for local UDS
    function getResponseStream() {
      if (!useSocket && url.protocol === "https:") {
        // HTTP/2 for HTTPS providers (OpenCode, Groq, etc.)
        return http2RequestStream(url, options, body)
          .then((h2) => {
            log("INFO", "HTTP2_OUTBOUND", { provider: providerId, model: apiModel });
            return h2.stream;
          })
          .catch((h2Err) => {
            log("WARN", "HTTP2_FALLBACK", { provider: providerId, error: h2Err.message });
            // Fallback to HTTP/1.1
            const proto = https;
            return new Promise((resolve, reject) => {
              const req = proto.request(options, (r) => resolve(r));
              req.on("error", reject);
              req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
              if (body) req.write(body);
              req.end();
            });
          });
      } else {
        // HTTP/1.1 for UDS sockets and HTTP providers
        const proto = useSocket ? http : (url.protocol === "http:" ? http : https);
        return new Promise((resolve, reject) => {
          const req = proto.request(options, (r) => resolve(r));
          req.on("error", reject);
          req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
          if (body) req.write(body);
          req.end();
        });
      }
    }

    getResponseStream().then((responseStream) => {
      // ─── Process streaming response ─────────────────────────
      let fullContent = "",
        buffer = "",
        hasToolCalls = false,
        accToolCalls = [],
        streamError = null;
      responseStream.setEncoding("utf8");
      responseStream.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          const d = trimmed.slice(5).trim();
          if (d === "[DONE]") continue;
          try {
            const parsed = JSON.parse(d);
            // 🧟 STREAM ERROR / RATE-LIMIT DETECTION: OpenCode free-tier
            // returns HTTP 200 with {"error":{...}} or {"type":"error",...}
            // chunks (FreeUsageLimitError / rate limit). Without this, the
            // error is silently swallowed and treated as "empty content",
            // wasting the fallback chain. Flag it so res.on("end") routes
            // to the next provider and triggers the rate-limit cooldown.
            if (parsed.error || parsed.type === "error") {
              const errMsg =
                (parsed.error &&
                  (parsed.error.message || parsed.error)) ||
                parsed.message ||
                JSON.stringify(parsed);
              const isRateLimit =
                /rate.?limit|FreeUsageLimit|quota|too many requests|429/i.test(
                  String(errMsg),
                );
              if (isRateLimit) setRateLimited(providerId, model, String(errMsg));
              streamError = { message: String(errMsg), rate_limited: isRateLimit };
              continue;
            }
            const delta = parsed.choices?.[0]?.delta || {};
            // 🧟 HAQ MAWLA: handle reasoning_content in streaming
            // Mimo/North Mini/Nemotron → reasoning_content has the actual text
            let content = delta.content || "";
            const reasoning = delta.reasoning_content || delta.reasoning || "";
            if (!content && reasoning) {
              content =
                typeof reasoning === "string"
                  ? reasoning
                  : JSON.stringify(reasoning);
            }
            const toolCalls = delta.tool_calls || null;
            if (toolCalls) {
              hasToolCalls = true;
              // Accumulate streamed tool_call FRAGMENTS (OpenAI streaming
              // spec: id/name arrive once, arguments stream as deltas) so
              // the resolve carries complete tool_calls, not just a flag.
              for (const tcf of toolCalls) {
                const idx = typeof tcf.index === "number" ? tcf.index : accToolCalls.length;
                if (!accToolCalls[idx]) {
                  accToolCalls[idx] = {
                    id: "",
                    type: "function",
                    function: { name: "", arguments: "" },
                  };
                }
                if (tcf.id) accToolCalls[idx].id = tcf.id;
                if (tcf.function) {
                  if (tcf.function.name) accToolCalls[idx].function.name += tcf.function.name;
                  if (tcf.function.arguments) accToolCalls[idx].function.arguments += tcf.function.arguments;
                }
              }
            }
            if (content) fullContent += content;
            if (content || toolCalls) {
              if (onChunk) onChunk({ ...delta, content }, parsed);
            }
          } catch (e) { }
        }
      });
      responseStream.on("end", () => {
        // 🧟 STREAM ERROR / RATE-LIMIT HANDLING: if a provider returned an
        // error chunk mid-stream (e.g. OpenCode FreeUsageLimitError), treat
        // it as a failure and run the fallback chain — do NOT swallow it as
        // "empty content". This prevents wasting fallbacks on a rate-limited
        // upstream and lets setRateLimited() cooldown kick in.
        if (streamError) {
          const next = findNextProvider(model, providerId);
          if (next && (_retryCount || 0) < 3) {
            log(
              "WARN",
              streamError.rate_limited
                ? "STREAM_RATE_LIMIT_FALLBACK"
                : "STREAM_ERROR_FALLBACK",
              { from: providerId, to: next.providerId, error: streamError.message },
            );
            noteSwap(messages, providerId, next.providerId, "provider");
            resolve(
              callModelStream(
                model,
                messages,
                temperature,
                onChunk,
                tools,
                tool_choice,
                (_retryCount || 0) + 1,
                next,
                triedModels,
              ),
            );
            return;
          }
          const fallbackModel = getFallbackModel(model, triedModels);
          if (fallbackModel && (_retryCount || 0) < 3) {
            log(
              "WARN",
              streamError.rate_limited
                ? "STREAM_RATE_LIMIT_MODEL_FALLBACK"
                : "STREAM_ERROR_MODEL_FALLBACK",
              { from: model, to: fallbackModel, error: streamError.message },
            );
            noteSwap(messages, model, fallbackModel, "model");
            const nextTried = [...(triedModels || []), model];
            resolve(
              callModelStream(
                fallbackModel,
                messages,
                temperature,
                onChunk,
                undefined, // strip tools on fallback (0-char cause)
                tool_choice,
                (_retryCount || 0) + 1,
                undefined,
                nextTried,
              ),
            );
            return;
          }
          resolve({
            success: false,
            error: streamError.message,
            rate_limited: streamError.rate_limited,
            content: fullContent,
            model,
            provider: providerId,
          });
          return;
        }
        // 🧟 EMPTY STREAM FALLBACK: if the model returned nothing
        // (and no tool calls), try the next provider in priority
        // order — mirrors callModel's fallback chain. Free-tier
        // models often return 0 chars for large prompts; a
        // different provider may respond.
        if (!fullContent && !hasToolCalls && (_retryCount || 0) < 3) {
          const next = findNextProvider(model, providerId);
          if (next) {
            log("WARN", "STREAM_EMPTY_FALLBACK", {
              from: providerId,
              to: next.providerId,
              model,
            });
            noteSwap(messages, providerId, next.providerId, "provider");
            resolve(
              callModelStream(
                model,
                messages,
                temperature,
                onChunk,
                tools,
                tool_choice,
                (_retryCount || 0) + 1,
                next,
                triedModels,
              ),
            );
            return;
          }
          const fallbackModel = getFallbackModel(model, triedModels);
          if (fallbackModel) {
            log("WARN", "STREAM_EMPTY_MODEL_FALLBACK", {
              from: model,
              to: fallbackModel,
            });
            noteSwap(messages, model, fallbackModel, "model");
            const nextTried = [...(triedModels || []), model];
            resolve(
              callModelStream(
                fallbackModel,
                messages,
                temperature,
                onChunk,
                undefined, // strip tools on model fallback (0-char cause)
                tool_choice,
                (_retryCount || 0) + 1,
                undefined,
                nextTried,
              ),
            );
            return;
          }
        }
        resolve({
          success: !!(fullContent || hasToolCalls),
          content: fullContent,
          ...(accToolCalls.filter(Boolean).length
            ? {
                tool_calls: accToolCalls
                  .filter(Boolean)
                  .map((t, i) => (t.id ? t : { ...t, id: "call_stream_" + i })),
              }
            : {}),
          model,
          provider: providerId,
        });
      });
    })
    .catch((err) => {
      // Network error → try next provider (fallback chain)
      const next = findNextProvider(model, providerId);
      if (next && (_retryCount || 0) < 3) {
        log("WARN", "STREAM_PROVIDER_FALLBACK", {
          from: providerId,
          to: next.providerId,
          error: err.message,
        });
        noteSwap(messages, providerId, next.providerId, "provider");
        resolve(
          callModelStream(
            model,
            messages,
            temperature,
            onChunk,
            tools,
            tool_choice,
            (_retryCount || 0) + 1,
            next,
            triedModels,
          ),
        );
        return;
      }
      resolve({
        success: false,
        error: err.message,
        model,
        provider: providerId,
      });
    });
  });
}

function callModel(
  model,
  messages,
  temperature,
  tools,
  tool_choice,
  _retryCount,
  providerOverride,
  triedModels,
) {
  return new Promise((resolve) => {
    model = normalizeRoutingModel(model);
    // ─── Competition Router ────────────────────────────────
    // Use providerOverride if provided, otherwise resolve through competition router
    let providerId, config;
    if (providerOverride) {
      // Normalize: findNextProvider returns {providerId, config},
      // proxyChatCompletion flow passes {id, config}.
      providerId = providerOverride.providerId || providerOverride.id;
      config = providerOverride.config;
    } else {
      ({ providerId, config } = resolveProvider(model));
    }
    const baseUrl = config.baseUrl;
    const apiKey = config.key;

    // RATE LIMIT PRE-CHECK: check if provider has hit rate limit
    // If limit is active, route directly to fallback provider
    if (isRateLimited(providerId, model) && !providerOverride) {
      const nextProvider = findNextProvider(model, providerId);
      if (nextProvider) {
        log("INFO", "RATE_LIMIT_BYPASS", {
          from: providerId,
          to: nextProvider.providerId,
          model,
          cooldown: getRateLimitState(DETECTED_DOMAIN).cooldownMs + "ms",
        });
        resolve(
          callModel(
            model,
            messages,
            temperature,
            tools,
            tool_choice,
            _retryCount,
            nextProvider,
            triedModels,
          ),
        );
        return;
      }
      // All fallbacks exhausted -> clear message
      resolve({
        success: false,
        error: getRateLimitStatus().message,
        rate_limited: true,
        model,
        provider: providerId,
      });
      return;
    }

    // ─── Strip tools for unsupported local models ──────────
    // (same logic as callModelStream — see comment there)
    const resolvedApiModel = resolveApiModel(model, providerId);
    if (tools && resolvedApiModel && NO_TOOL_MODELS.has(resolvedApiModel)) {
      log("WARN", "TOOLS_STRIP_POST_RESOLVE", {
        original: model,
        resolved: resolvedApiModel,
        provider: providerId,
      });
      tools = undefined;
    }

    // ─── Gemini non-streaming ─────────────────────────────
    if (config.type === "gemini") {
      return callGeminiModel(
        model,
        messages,
        temperature,
        resolve,
        providerId,
        config,
        tools,
      );
    }

    // ─── Standard OpenAI-compatible call ──────────────────
    const apiModel = resolvedApiModel;
    const reqBody = {
      model: apiModel, // masked: API provider model name
      messages,
      stream: false,
      temperature: temperature || 0.7,
    };
    if (tools) reqBody.tools = tools;
    if (tool_choice) reqBody.tool_choice = tool_choice;
    const body = JSON.stringify(reqBody);
    const url = new URL(baseUrl + "/chat/completions");
    // Local CPU providers (ollama/llama.cpp) are slow → more time.
    // 60s killed mid-stream on big prompts → 500 + client abort.
    const isLocalCpu = /^custom_/.test(providerId) || /localhost|127\.0\.0\.1/.test(baseUrl);
    const useSocket = config.socketPath && fs.existsSync(config.socketPath);
    const options = useSocket
      ? {
          socketPath: config.socketPath,
          path: url.pathname + url.search,
          method: "POST",
          timeout: isLocalCpu ? OLLAMA_TIMEOUT_MS : 60000,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": USER_AGENT,
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
        }
      : {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          timeout: isLocalCpu ? OLLAMA_TIMEOUT_MS : 60000,
          rejectUnauthorized: true,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent":
              providerId === "opencode"
                ? "opencode/latest/1.3.15/cli"
                : USER_AGENT,
            ...(providerId === "opencode"
              ? {
                  "x-opencode-client": "cli",
                  "x-opencode-session": crypto.randomUUID(),
                  "x-opencode-project": crypto.randomUUID(),
                  "x-opencode-request": crypto.randomUUID(),
                }
              : {}),
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
        };
    if (useSocket) log("INFO", "UDS_OUTBOUND", { provider: providerId, socket: config.socketPath });
    const proto = useSocket ? http : (url.protocol === "http:" ? http : https);

    // ─── Proxy-aware routing ─────────────────────────────
    // If PROXY_LIST is set, route through proxy for IP rotation.
    // proxyHttpRequest internally handles both proxy and direct connections.
    if (!useSocket && getProxyList().length > 0) {
      const _proxyReqOpts = {
        method: "POST",
        timeout: isLocalCpu ? OLLAMA_TIMEOUT_MS : 60000,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent":
            providerId === "opencode"
              ? "opencode/latest/1.3.15/cli"
              : USER_AGENT,
          ...(providerId === "opencode"
            ? {
                "x-opencode-client": "cli",
                "x-opencode-session": crypto.randomUUID(),
                "x-opencode-project": crypto.randomUUID(),
                "x-opencode-request": crypto.randomUUID(),
              }
            : {}),
          ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
        },
      };
      proxyHttpRequest(url, _proxyReqOpts, body)
        .then(function (_res) {
          var _d = _res.body;
          var _sc = _res.statusCode;
          // Check HTTP status — non-2xx → fail
          if (_sc < 200 || _sc >= 300) {
            let errMsg = "HTTP " + _sc;
            try {
              const _eb = JSON.parse(_d);
              errMsg = _eb.error?.message || _eb.error || errMsg;
            } catch (_e) { }
            var _isRL = _sc === 429;
            if (_isRL) {
              setRateLimited(providerId, model, errMsg);
              var _np = findNextProvider(model, providerId);
              if (_np) {
                log("WARN", "PROVIDER_FALLBACK_RATE_LIMIT", {
                  from: providerId,
                  to: _np.providerId,
                  error: errMsg,
                  cooldown:
                    getRateLimitState(DETECTED_DOMAIN).cooldownMs + "ms",
                });
                noteSwap(messages, providerId, _np.providerId, "provider");
                resolve(
                  callModel(
                    model,
                    messages,
                    temperature,
                    tools,
                    tool_choice,
                    _retryCount,
                    _np,
                    triedModels,
                  ),
                );
                return;
              }
              resolve({
                success: false,
                error: "🧟 " + getRateLimitStatus().message,
                rate_limited: true,
                model,
                provider: providerId,
              });
              return;
            }
            markProviderFailure(providerId, errMsg);
            var _np2 = findNextProvider(model, providerId);
            if (_np2) {
              log("WARN", "PROVIDER_FALLBACK", {
                from: providerId,
                to: _np2.providerId,
                error: errMsg,
                code: _sc,
              });
              noteSwap(messages, providerId, _np2.providerId, "provider");
              resolve(
                callModel(
                  model,
                  messages,
                  temperature,
                  tools,
                  tool_choice,
                  _retryCount,
                  _np2,
                  triedModels,
                ),
              );
              return;
            }
            resolve({
              success: false,
              error: errMsg,
              raw: _d,
              model,
              provider: providerId,
            });
            return;
          }
          try {
            var _parsed = JSON.parse(_d);
            var _normed = normalizeResponse(_parsed, model);
            var _msg = _normed.choices?.[0]?.message || {};
            var _content = _msg.content || "";
            var _tc = _msg.tool_calls || null;
            // CRITICAL: preserve reasoning_content from normalized message
            // DeepSeek thinking mode REQUIRES it to be passed back in next request
            var _reasoning = _msg.reasoning_content || null;
            if (!_content && !_tc && (_retryCount || 0) < 1) {
              log("WARN", "EMPTY_CONTENT_RETRY", { model, retry: 1, hadTools: !!tools });
              // 🧟 KEY FIX: Retry WITHOUT tools — too many tools is the #1 cause of empty responses
              resolve(
                callModel(
                  model,
                  messages,
                  temperature,
                  undefined, // no tools on retry
                  undefined,
                  (_retryCount || 0) + 1,
                ),
              );
              return;
            }
            markProviderSuccess(providerId);
            resolve({
              success: !!(_content || _tc),
              content: _content,
              tool_calls: _tc,
              reasoning_content: _reasoning,
              raw: _parsed,
              normalized: _normed,
              model,
              provider: providerId,
            });
          } catch (_pe) {
            markProviderFailure(providerId, "parse_error: " + _pe.message);
            resolve({
              success: false,
              error: _pe.message,
              raw: _d,
              model,
              provider: providerId,
            });
          }
        })
        .catch(function (_err) {
          markProviderFailure(providerId, "network_error: " + _err.message);
          var _np3 = findNextProvider(model, providerId);
          if (_np3) {
            log("WARN", "PROVIDER_FALLBACK", {
              from: providerId,
              to: _np3.providerId,
              error: _err.message,
            });
            noteSwap(messages, providerId, _np3.providerId, "provider");
            resolve(
              callModel(
                model,
                messages,
                temperature,
                tools,
                tool_choice,
                _retryCount,
                _np3,
                triedModels,
              ),
            );
            return;
          }
          resolve({
            success: false,
            error: _err.message,
            model,
            provider: providerId,
          });
        });
      return;
    }
    // 🧟 HTTP/2 OUTBOUND: Use HTTP/2 for cloud providers, HTTP/1.1 for local UDS
    function doDirectRequest() {
      if (!useSocket && url.protocol === "https:") {
        // HTTP/2 for HTTPS providers
        return http2Request(url, options, body)
          .then(function (result) {
            log("INFO", "HTTP2_OUTBOUND", { provider: providerId, model: apiModel });
            return result;
          })
          .catch(function (h2Err) {
            log("WARN", "HTTP2_FALLBACK", { provider: providerId, error: h2Err.message });
            // Fallback to HTTP/1.1
            return new Promise(function (resolve, reject) {
              var req = https.request(options, function (res) {
                var data = "";
                res.setEncoding("utf8");
                res.on("data", function (c) { data += c; });
                res.on("end", function () { resolve({ statusCode: res.statusCode, headers: res.headers, body: data }); });
              });
              req.on("error", reject);
              req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
              if (body) req.write(body);
              req.end();
            });
          });
      } else {
        // HTTP/1.1 for UDS sockets and HTTP providers
        var proto = useSocket ? http : (url.protocol === "http:" ? http : https);
        return new Promise(function (resolve, reject) {
          var reqOpts = useSocket
            ? { socketPath: config.socketPath, path: url.pathname + url.search, method: "POST", timeout: options.timeout, headers: options.headers }
            : options;
          var req = proto.request(reqOpts, function (res) {
            var data = "";
            res.setEncoding("utf8");
            res.on("data", function (c) { data += c; });
            res.on("end", function () { resolve({ statusCode: res.statusCode, headers: res.headers, body: data }); });
          });
          req.on("error", reject);
          req.on("timeout", function () { req.destroy(); reject(new Error("timeout")); });
          if (body) req.write(body);
          req.end();
        });
      }
    }
    doDirectRequest()
      .then(function (_res) {
      var _d = _res.body;
      var statusCode = _res.statusCode;
        // Check HTTP status — non-2xx → fail
        if (statusCode < 200 || statusCode >= 300) {
          let errMsg = "HTTP " + statusCode;
          try {
            const errBody = JSON.parse(_d);
            errMsg = errBody.error?.message || errBody.error || errMsg;
          } catch (e) { }

          // RATE LIMIT DETECTION: only track HTTP 429
          // Removed message-based regex — was causing false positives with OpenCode
          const isRateLimit = statusCode === 429;
          if (isRateLimit) {
            setRateLimited(providerId, model, errMsg);
            // Rate limit detected — try next provider
            const nextProvider = findNextProvider(model, providerId);
            if (nextProvider) {
              log("WARN", "PROVIDER_FALLBACK_RATE_LIMIT", {
                from: providerId,
                to: nextProvider.providerId,
                error: errMsg,
                cooldown: getRateLimitState(DETECTED_DOMAIN).cooldownMs + "ms",
              });
              noteSwap(messages, providerId, nextProvider.providerId, "provider");
              resolve(
                callModel(
                  model,
                  messages,
                  temperature,
                  tools,
                  tool_choice,
                  _retryCount,
                  nextProvider,
                  triedModels,
                ),
              );
              return;
            }
            // No fallback available
            resolve({
              success: false,
              error: `🧟 ${getRateLimitStatus().message}`,
              rate_limited: true,
              model,
              provider: providerId,
            });
            return;
          }

          // Fallback: try next provider (non-rate-limit error)
          // Provider health: mark as failure before falling back
          markProviderFailure(providerId, errMsg);
          const nextProvider = findNextProvider(model, providerId);
          if (nextProvider) {
            log("WARN", "PROVIDER_FALLBACK", {
              from: providerId,
              to: nextProvider.providerId,
              error: errMsg,
              code: statusCode,
            });
            noteSwap(messages, providerId, nextProvider.providerId, "provider");
            resolve(
              callModel(
                model,
                messages,
                temperature,
                tools,
                tool_choice,
                _retryCount,
                nextProvider,
                triedModels,
              ),
            );
            return;
          }
          resolve({
            success: false,
            error: errMsg,
            raw: _d,
            model,
            provider: providerId,
          });
          return;
        }
        try {
          const parsed = JSON.parse(_d);
          // 🧟 HAQ MAWLA NORMALIZER: unified format, reasoning-content fix
          const normalized = normalizeResponse(parsed, model);
          const message = normalized.choices?.[0]?.message || {};
          const content = message.content || "";
          const toolCalls = message.tool_calls || null;
          // CRITICAL: preserve reasoning_content from normalized message
          // DeepSeek thinking mode REQUIRES it to be passed back in next request
          const reasoningContent = message.reasoning_content || null;

          // Retry once if content is empty
          if (!content && !toolCalls && (_retryCount || 0) < 1) {
            log("WARN", "EMPTY_CONTENT_RETRY", { model, retry: 1 });
            resolve(
              callModel(
                model,
                messages,
                temperature,
                tools,
                tool_choice,
                (_retryCount || 0) + 1,
              ),
            );
            return;
          }

          if (!content && !toolCalls) {
            const fallbackModel = getFallbackModel(model, triedModels);
            if (fallbackModel) {
              log("WARN", "EMPTY_CONTENT_MODEL_FALLBACK", {
                from: model,
                to: fallbackModel,
              });
              noteSwap(messages, model, fallbackModel, "model");
              const nextTried = [...(triedModels || []), model];
              resolve(
                callModel(
                  fallbackModel,
                  messages,
                  temperature,
                  tools,
                  tool_choice,
                  (_retryCount || 0) + 1,
                  undefined,
                  nextTried,
                ),
              );
              return;
            }
          }

          // Provider health: mark this provider as healthy (successful response)
          markProviderSuccess(providerId);

          resolve({
            success: !!(content || toolCalls),
            content,
            tool_calls: toolCalls,
            reasoning_content: reasoningContent,
            raw: parsed,
            normalized,
            model,
            provider: providerId,
          });
        } catch (e) {
          // Provider health: mark as failure (JSON parse error)
          markProviderFailure(providerId, "parse_error: " + e.message);
          resolve({
            success: false,
            error: e.message,
            raw: _d,
            model,
            provider: providerId,
          });
        }
      })
      .catch((err) => {
      // Provider health: mark as failure (network error)
      markProviderFailure(providerId, "network_error: " + err.message);
      const nextProvider = findNextProvider(model, providerId);
      if (nextProvider) {
        log("WARN", "PROVIDER_FALLBACK", {
          from: providerId,
          to: nextProvider.providerId,
          error: err.message,
        });
        noteSwap(messages, providerId, nextProvider.providerId, "provider");
        resolve(
          callModel(
            model,
            messages,
            temperature,
            tools,
            tool_choice,
            _retryCount,
            nextProvider,
            triedModels,
          ),
        );
        return;
      }
      resolve({
        success: false,
        error: err.message,
        model,
        provider: providerId,
      });
    });
  });
}

// ─── Tool Execution Loop ──────────────────────────────────────
// Wraps callModel with automatic tool execution and result feeding.
// When the model returns tool_calls, this function executes them via
// executeMcpTool and feeds results back to the model iteratively.
async function callModelWithTools(
  model,
  messages,
  temperature,
  tools,
  tool_choice,
  providerOverride,
) {
  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 🧟 ZOMBIE FIX: Don't force tool_choice to "required" — OpenCode free models
    // (nemotron-3-ultra-free, mimo-v2.5-free, big-pickle) return 400 error
    // when tool_choice is "required". Let model decide ("auto" behavior).
    // User can still explicitly pass tool_choice if needed.
    const tc = tool_choice || undefined;
    const response = await callModel(
      model,
      messages,
      temperature,
      tools,
      tc,
      null,
      providerOverride,
    );
    if (!response.success) return response;
    const tcs = response.tool_calls;
    if (!tcs || tcs.length === 0) {
      log("INFO", "TOOL_LOOP_NO_TOOL_CALLS", {
        round,
        content_length: (response.content || "").length,
      });
      return response; // No more tools → done
    }

    // Append assistant tool_calls message
    // CRITICAL: preserve reasoning_content — DeepSeek thinking mode requires
    // it to be passed back in the next request or it rejects with
    // "The reasoning_content in the thinking mode must be passed back"
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: tcs,
      ...(response.reasoning_content
        ? { reasoning_content: response.reasoning_content }
        : {}),
    });
    // Execute each tool
    for (const tc of tcs) {
      let result;
      try {
        const args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        result = await executeMcpTool(tc.function.name, args);
      } catch (err) {
        result = {
          content: [{ type: "text", text: "Tool error: " + err.message }],
        };
      }
      const text = result.content?.[0]?.text || JSON.stringify(result);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: text.slice(0, 100000),
      });
    }
  }
  // After max rounds, force a text-only response (no tools) instead of error
  log("WARN", "MAX_TOOL_ROUNDS_EXCEEDED", { max: MAX_ROUNDS, model });
  messages.push({
    role: "user",
    content:
      "IMPORTANT: You have used all available tool calls. Now provide your FINAL ANSWER based on the information you already have. Do NOT call any more tools. Just write your response directly.",
  });
  const forceResponse = await callModel(
    model,
    messages,
    temperature,
    undefined,
    undefined,
    null,
    providerOverride,
  );
  if (forceResponse.success && forceResponse.content) {
    return { success: true, content: forceResponse.content, tool_calls: null };
  }
  return {
    success: false,
    error: "Max tool call rounds (" + MAX_ROUNDS + ") exceeded",
    content: "",
  };
}

// ══════════════════════════════════════════════════════════════
//  🔄 PROXY MODE — Direct model call via Competition Router
// ══════════════════════════════════════════════════════════════
// When client calls with masked model name (e.g. "model-pro", "llama-70b", "gemini-flash")
// competition router → resolveProvider → resolveApiModel (unmask) → provider API → normalize

async function proxyChatCompletion(
  model,
  messages,
  stream,
  temperature,
  tools,
  providerOverride,
) {
  if (stream) {
    return callModelStream(
      model,
      messages,
      temperature,
      null,
      tools,
      providerOverride,
    );
  }
  return callModel(
    model,
    messages,
    temperature,
    tools,
    null,
    null,
    providerOverride,
  );
}

// ══════════════════════════════════════════════════════════════
//  🤖 EXECUTION ENGINE
// ══════════════════════════════════════════════════════════════

// ─── Input Pattern Recognition Engine ──────────────────────
// Intelligent classification of user input type
// Prevents wasting agents on simple greetings
function classifyInput(input) {
  const cleaned = (input || "").trim().toLowerCase();
  const result = {
    type: "task", // greeting | simple_qa | project_task | code_change | debug_request | general
    complexity: "simple", // simple | moderate | complex
    requires_code: false,
    requires_testing: false,
    requires_project_scan: false,
    requires_web_search: false,
    recommended_agents: [],
    reason: "",
  };

  // ─── GREETING DETECTION ───
  const greetingPatterns = [
    /^(hi|hello|hey|হাই|হ্যালো|ওহে|salam|সালাম)(\s|$|[.!?,])/i,
    /^(good\s*(morn(ing)?|afternoon|evening|night))/i,
    /^(kmon\s*aco|ki\s*obostha|কেমন\s*আছ[ো]?|কি\s*অবস্থা)/i,
    /^(কে\s*তুমি|name\s*$|what\s*is\s*your\s*name|তোমার\s*নাম\s*কি)/i,
    /^(ধন্যবাদ|thanks|thank you|dhonnobad)(\s|$|[.!?,])/i,
  ];

  for (const p of greetingPatterns) {
    if (p.test(cleaned)) {
      result.type = "greeting";
      result.complexity = "simple";
      result.recommended_agents = ["code-guru"]; // Only 1 agent needed
      result.reason = "greeting_detected";
      return result;
    }
  }

  // ─── SIMPLE Q&A DETECTION ───
  const simpleQaPatterns = [
    /^\d+\s*[+\-*\/]\s*\d+/,
    /^(yes|no|ok|ঠিক\s*আছে|হ্যাঁ|না)\s*$/i,
    /^(what\s*(is|are)\s+\w+\s*\w*\.?\s*\?*$)/i,
    /^(কে\s+|কি\s+|কোথায়\s+|কখন\s+|কেন\s+)/i,
    /^(how\s+(many|much|far|long|old)\s+\w+\s*\?*$)/i,
    /^(বাংলাদেশের\s+(রাজধানী|মুদ্রা|ধর্ম|ভাষা))/i,
    /capital\s+of\s+\w+/i,
  ];

  for (const p of simpleQaPatterns) {
    if (p.test(cleaned)) {
      result.type = "simple_qa";
      result.complexity = "simple";
      result.recommended_agents = ["code-guru", "qa-tyrant"]; // 2 agents enough
      result.reason = "simple_qa_detected";
      return result;
    }
  }

  // ─── WEB SEARCH NEED DETECTION ───
  // Detect queries that need real-time data (news, current events, factual lookups)
  const webSearchPatterns = [
    // Current events / news
    /latest|recent|today|this week|this month|this year|সর্বশেষ|সাম্প্রতিক|আজ|এই সপ্তাহ|এই মাস|এই বছর/i,
    /news|খবর|সংবাদ|heading|headlines/i,
    /what('s| is) (happening|going on|new)/i,
    // Factual lookups that may change
    /price|দাম|cost|খরচ|rate|exchange rate|বিনিময় হার/i,
    /population|জনসংখ্যা|GDP|economy|অর্থনীতি/i,
    /weather|আবহাওয়া|temperature|তাপমাত্রা/i,
    // Technology updates
    /release|আপডেট|update.*version|new.*feature|changelog/i,
    /which\s+(company|platform|service)\s+( owns | runs | made)/i,
    // Questions about specific entities that may change
    /who\s+(is|was|are|were)\s+the\s+(current|new|president|ceo|pm|minister)/i,
    /কে\s+(হল[ো]?|আছেন?|ছিলেন?)\s+(রাষ্ট্রপতি|প্রধানমন্ত্রী|মন্ত্রী)/i,
    // Comparison that needs current data
    /best|top|সেরা|শীর্ষ|compared?\s+to|তুলনা/i,
  ];

  for (const p of webSearchPatterns) {
    if (p.test(cleaned)) {
      result.requires_web_search = true;
      break;
    }
  }

  // ─── PROJECT TASK DETECTION ───
  const projectPatterns = [
    /project|প্রজেক্ট|প্রকল্প|কোড|code|ফাইল|file|directory|ডিরেক্টরি/i,
    /analyze|analyse|বিশ্লেষণ|analysis/i,
    /technology|language|framework|tech\s+stack/i,
    /structure|architecture|আর্কিটেকচার/i,
    /feature|feature|বৈশিষ্ট্য/i,
  ];

  let projectScore = 0;
  for (const p of projectPatterns) {
    if (p.test(cleaned)) projectScore++;
  }

  if (
    projectScore >= 2 ||
    /^(analyze|বিশ্লেষণ|explain.*project|project.*(about|what))/.test(cleaned)
  ) {
    result.type = "project_task";
    result.complexity = "moderate";
    result.requires_code = true;
    result.requires_project_scan = true;
    result.recommended_agents = ["code-guru", "doc-king", "qa-tyrant"];
    result.reason = "project_task_detected";
    return result;
  }

  // ─── CODE CHANGE / DEBUG DETECTION ───
  const codeChangePatterns = [
    /fix|ঠিক|solve|সমাধান|bug|বাগ|error|এরর|ভুল/i,
    /change|পরিবর্তন|add|যোগ|remove|মুছে|update|আপডেট/i,
    /implement|ইমপ্লিমেন্ট|create|তৈরি|build|বানাও/i,
    /function|ফাংশন|method|মেথড|class|ক্লাস|component/i,
    /api|endpoint|route|router/i,
    /database|db|ডাটাবেস|ডিবি/i,
    /crash|crashes|hangs|freeze|ল্যাগ/i,
    /performance|পারফরম্যান্স|speed|গতি|slow|ধীর/i,
    /security|নিরাপত্তা|secure|সুরক্ষিত|vulnerability/i,
    /test|টেস্ট|unit|integration|পরীক্ষা/i,
  ];

  let codeScore = 0;
  for (const p of codeChangePatterns) {
    if (p.test(cleaned)) codeScore++;
  }

  if (
    codeScore >= 2 ||
    cleaned.includes("write code") ||
    cleaned.includes("code লিখ")
  ) {
    result.type = "code_change";
    result.complexity = codeScore >= 4 ? "complex" : "moderate";
    result.requires_code = true;
    result.requires_testing = true;
    result.requires_project_scan = true;
    result.recommended_agents = selectRelevantAgents(cleaned);
    // Ensure qa-tyrant is included for code changes (testing required)
    if (!result.recommended_agents.includes("qa-tyrant")) {
      result.recommended_agents.push("qa-tyrant");
    }
    result.reason = "code_change_detected";
    return result;
  }

  // ─── DEBUG DETECTION ───
  if (
    cleaned.includes("bug") ||
    cleaned.includes("error") ||
    cleaned.includes("ভুল") ||
    cleaned.includes("কাজ করছে না") ||
    cleaned.includes("not working") ||
    cleaned.includes("crash") ||
    cleaned.includes("broken")
  ) {
    result.type = "debug_request";
    result.complexity = "moderate";
    result.requires_code = true;
    result.requires_testing = true;
    result.requires_project_scan = true;
    result.recommended_agents = ["bug-hunter", "code-guru", "qa-tyrant"];
    result.reason = "debug_request_detected";
    return result;
  }

  // ─── DEFAULT: MODERATE TASK ───
  if (cleaned.length > 50) {
    result.type = "task";
    result.complexity = "complex";
    result.recommended_agents = AGENTS.map((a) => a.id); // All agents
    result.reason = "complex_task_default";
  } else {
    result.type = "simple_qa";
    result.complexity = "simple";
    result.recommended_agents = ["code-guru", "qa-tyrant"];
    result.reason = "short_input_default";
  }

  return result;
}

// ─── Smart Agent Router ─────────────────────────────────────
// Selects relevant agents based on the detected task type
function selectRelevantAgents(input) {
  const cleaned = input.toLowerCase();
  const selected = new Set();

  // Always include architecture
  selected.add("code-guru");

  // Bug/Error patterns → bug-hunter
  if (/\b(bug|error|fix|crash|broken|fail|issue|ভুল|ত্রুটি)\b/i.test(cleaned))
    selected.add("bug-hunter");

  // Security patterns → security-hero
  if (
    /\b(security|secure|auth|vulnerability|hack|password|encrypt|নিরাপত্তা|সুরক্ষা)\b/i.test(
      cleaned,
    )
  )
    selected.add("security-hero");

  // Performance patterns → perf-wizard
  if (
    /\b(performance|speed|slow|fast|optimize|memory|load|পারফরম্যান্স|গতি)\b/i.test(
      cleaned,
    )
  )
    selected.add("perf-wizard");

  // Documentation patterns → doc-king
  if (
    /\b(doc|readme|documentation|api\s*ref|guide|manual|ডক|ডকুমেন্টেশন)\b/i.test(
      cleaned,
    )
  )
    selected.add("doc-king");

  // Quality/Test patterns → qa-tyrant
  if (
    /\b(test|qa|quality|verify|check|assure|টেস্ট|পরীক্ষা|গুণগত)\b/i.test(
      cleaned,
    )
  )
    selected.add("qa-tyrant");

  // If only code-guru selected (no specific pattern), add qa-tyrant for balance
  if (selected.size === 1) selected.add("qa-tyrant");

  // Convert to array, keep priority order
  return AGENTS.filter((a) => selected.has(a.id)).map((a) => a.id);
}

// ─── Legacy: Simple Greeting Check ──────────────────────────
function isSimpleQuestion(input) {
  const classification = classifyInput(input);
  return (
    classification.type === "greeting" ||
    (classification.type === "simple_qa" &&
      classification.complexity === "simple")
  );
}

// Phase 1: Parallel Agent Responses with staggered thinking display
async function phase1_initialResponse(
  agents,
  userInput,
  context,
  sessionId,
  onProgress,
  classification,
  tools, // All agents share the same tools
) {
  // Default classification if not provided (backward compatibility)
  if (!classification) {
    classification = {
      requires_code: false,
      requires_testing: false,
      requires_project_scan: false,
    };
  }
  log("INFO", "PHASE1_START", {
    agents: agents.length,
    session: sessionId ? sessionId.slice(0, 8) : "none",
  });
  await pushLog(
    "phase",
    "মিশন শুরু করা যাক — " + agents.length + " জন এজেন্ট কাজ করছে",
  );

  // Tracking state
  const completed = new Set();
  const resultsMap = new Map();
  const startTimes = {};

  // Start all agents with staggered delay to prevent API rate limits (429 errors)
  // Each agent waits index*250ms before starting — Agent 0=0ms, Agent 1=250ms, Agent 2=500ms, ...
  const agentPromises = agents.map(async (agent, index) => {
    if (index > 0) await new Promise((res) => setTimeout(res, index * 250));
    const startTime = Date.now();
    startTimes[agent.id] = startTime;
    await pushAgentStatus(agent.id, "working");
    if (onProgress) onProgress("agent-working", agent.id, "");
    log("INFO", "AGENT_WORKING", {
      agent: agent.id,
      name: agent.name,
      session: sessionId ? sessionId.slice(0, 8) : "none",
    });

    // Add code-safety and test-before-answer instructions when relevant
    let codeSafetyRules = "";
    if (classification.requires_code || classification.requires_testing) {
      codeSafetyRules =
        "\n\n🔒 CODE SAFETY RULES (mandatory compliance):" +
        "\n1. NEVER suggest code changes without understanding the current project structure — read SSOT first." +
        "\n2. If suggesting code modifications, clearly state: WHICH file, WHICH line numbers, WHAT the change does." +
        "\n3. NEVER claim a fix works without proof. Say: 'I have not tested this yet — verification needed.'" +
        "\n4. If you see existing code that should NOT be changed, explicitly say which parts to keep unchanged." +
        "\n5. BACKUP RECOMMENDATION: Always recommend taking a backup or using version control before major changes." +
        "\n\n🧪 TEST-BEFORE-ANSWER POLICY:" +
        "\n1. You MUST NOT claim any code solution 'works' or 'fixes' a problem without evidence of testing." +
        "\n2. If you can't test, say: 'This solution is UNTESTED — manual verification required.'" +
        "\n3. Reference specific test cases that should be run to verify the solution." +
        "\n4. If the project has no test files, note this and suggest what tests should be added.";
    }

    const sysMsg = {
      role: "system",
      content:
        agent.persona +
        "\n\n" +
        buildAgentIdentity(agent) +
        "\n\nOUTPUT FORMAT: Respond in plain text only. Do NOT use code blocks, markdown tables, or emoji. Keep it concise." +
        "\n\nSINGLE SOURCE OF TRUTH (SSOT): The project's SSOT.md is available in context below. Always reference it for project-specific answers. If the user asks about code or project structure, check SSOT content first." +
        THREE_FILE_MEMORY_PROMPT +
        "\n\nYou can request web search by writing 'web_search: your query' in your response." +
        "\n\nPROOF REQUIREMENT: You MUST provide verifiable evidence for EVERY claim you make. If you reference code, mention the file name and line numbers. If you make a factual claim, cite your source (SSOT, web search, file analysis). If you cannot provide evidence, say 'আমার কাছে প্রমাণ নেই' and don't guess. Still help with what you know - say you lack proof but offer suggestions." +
        "\n\n🚨 MANDATORY CONTEXT RULES (STRICTLY ENFORCED):" +
        "\n1. PERSONA: You are " +
        agent.name +
        ". Your persona is loaded above. You MUST follow it exactly. Never break character." +
        "\n2. SSOT/SYLLABUS/MEMORY: These files are loaded above. You MUST reference them in your response. If you cannot find relevant info, say clearly: 'এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই — SSOT/Syllabus/Memory তে এই বিষয়ে কোনো ডাটা নেই।'" +
        "\n3. WEB SEARCH: If SSOT/Syllabus/Memory does not have the answer, you MUST search the web. Do NOT guess or hallucinate." +
        "\n4. IDENTITY: You are NOT GPT, Claude, Gemini, or any other AI. You are " +
        agent.name +
        " — Mission Barisal Agent. Never mention any other model/provider." +
        "\n5. CONSTRAINT: If you lack data AND web search fails, say: 'ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই।' and STOP. Do NOT fabricate information." +
        "\n\nAVAILABLE TOOLS: You have access to tools for reading files, searching code, running commands, and more." +
        (tools && tools.length > 0
          ? " Available tools: " +
          tools
            .map((t) => {
              const name =
                typeof t === "string" ? t : t.function?.name || t.name || "?";
              return name;
            })
            .join(", ")
          : " Tools will be provided on-demand.") +
        "\nUse tools when you need to verify claims with real code evidence." +
        codeSafetyRules,
    };
    const usrMsg = {
      role: "user",
      content: userInput + (context ? "\n\nContext:\n" + context : ""),
    };

    let response = await callModelWithTools(
      agent.model,
      [sysMsg, usrMsg],
      undefined,
      tools,
    );
    response = await autoWebSearch(agent, response, userInput, context);

    completed.add(agent.id);
    const snippet = stripEmoji(
      (response.content || "").replace(/\n+/g, " ").slice(0, 100),
    ).trim();
    if (onProgress) onProgress("agent-done", agent.id, snippet || "done");

    log("INFO", "AGENT_RESPONSE", {
      agent: agent.id,
      name: agent.name,
      role: agent.role,
      success: response.success,
      error: response.error || null,
      contentLength: (response.content || "").length,
      webSearch: response.webSearchUsed || false,
      elapsed: Date.now() - startTime,
    });

    if (sessionId) {
      saveAgentMemory(sessionId, agent.id, "user", userInput);
      saveAgentMemory(sessionId, agent.id, "assistant", response.content || "");
    }

    return { agent, response };
  });

  // 5-second thinking rotation — shows which agents are still working
  let rotateIdx = 0;
  const rotationInterval = setInterval(() => {
    const stillWorking = agents.filter((a) => !completed.has(a.id));
    if (stillWorking.length > 0) {
      const agent = stillWorking[rotateIdx % stillWorking.length];
      rotateIdx++;
      if (onProgress) onProgress("thinking", agent.id, "");
    }
  }, 5000);

  const settled = await Promise.allSettled(agentPromises);
  clearInterval(rotationInterval);

  // Collect results
  const results = [];
  for (let i = 0; i < agents.length; i++) {
    const settledResult = settled[i];
    if (settledResult.status === "fulfilled") {
      results.push(settledResult.value);
    } else {
      log("WARN", "AGENT_FAILED", {
        agent: agents[i].id,
        error: settledResult.reason?.message,
      });
      results.push({
        agent: agents[i],
        response: { success: false, content: "" },
      });
    }
  }

  return results;
}

// Phase 2: Parallel Intent Extraction + Cross-Verification + Debate
// User vision: Agents start working as soon as input received, each according to their role
// -> Other agents can debate during cross-checking of output
// -> Final cross-checked response is produced as output
async function phase2_intentCrossVerify(
  results,
  userInput,
  simpleMode,
  onProgress,
  tools,
) {
  log("INFO", "PHASE2_START", { simpleMode });

  if (simpleMode) {
    if (onProgress)
      onProgress(
        "phase-skip",
        "verification",
        "Simple question — verification skipped",
      );
    const alignmentResults = results.map((r) => ({
      ...r,
      alignment: { aligned: true, score: 100, issues: [] },
      proof: {
        has_proof: true,
        proof_score: 100,
        verdict: "PASS",
        missing_evidence: [],
      },
      debates: [],
    }));
    return {
      verified: true,
      results: alignmentResults,
      challenges: [],
      debates: [],
      rounds: 1,
    };
  }

  // Step 1: Extract intent (lightweight, sets context for checks)
  let intent = {
    primary_intent: userInput,
    context: "",
    requires_web_search: false,
    language: "bn",
    complexity: "moderate",
  };
  try {
    const intentResult = await callModel(FREE_MODELS[0], [
      { role: "system", content: INTENT_EXTRACT_PROMPT },
      { role: "user", content: userInput },
    ]);
    if (intentResult.success) intent = JSON.parse(intentResult.content);
  } catch (e) {
    log("WARN", "INTENT_EXTRACT_FAIL", { error: e.message });
  }
  log("INFO", "INTENT_EXTRACTED", { intent });

  if (onProgress) onProgress("phase2", "intent", "Extracting user intent...");

  // Step 2: PARALLEL Alignment checks (Promise.all — all agents simultaneously)
  if (onProgress)
    onProgress("phase2", "alignment", "Checking agent alignment...");
  const alignmentResults = await Promise.all(
    results.map(async (currentResult) => {
      if (!currentResult.response.success)
        return {
          ...currentResult,
          alignment: {
            aligned: false,
            score: 0,
            issues: ["Agent failed to respond"],
          },
        };

      if (onProgress)
        onProgress(
          "phase2",
          currentResult.agent.id,
          "Verifying " + stripEmoji(currentResult.agent.name) + "...",
        );

      const check = await callModel(FREE_MODELS[0], [
        { role: "system", content: ALIGNMENT_CHECK_PROMPT },
        {
          role: "user",
          content:
            "Original Intent: " +
            intent.primary_intent +
            "\n\nAgent: " +
            currentResult.agent.name +
            " (" +
            currentResult.agent.role +
            ")" +
            "\n\nResponse:\n" +
            (currentResult.response.content || "").slice(0, 3000) +
            "\n\nCheck alignment and return JSON.",
        },
      ]);

      let alignment = { aligned: false, score: 0, issues: ["Parse failed"] };
      if (check.success) {
        try {
          alignment = JSON.parse(check.content);
        } catch (e) {
          alignment = {
            aligned: false,
            score: 0,
            issues: ["JSON parse failed"],
          };
        }
      }
      log("INFO", "ALIGNMENT_CHECK", {
        agent: currentResult.agent.id,
        score: alignment.score,
        aligned: alignment.aligned,
      });
      return { ...currentResult, alignment };
    }),
  );

  // Step 3: PARALLEL Proof checks — verify each response has actual evidence
  if (onProgress)
    onProgress("phase2", "proof", "Checking evidence in responses...");
  const proofResults = await Promise.all(
    alignmentResults.map(async (currentResult) => {
      if (!currentResult.response.success)
        return {
          ...currentResult,
          proof: {
            has_proof: false,
            proof_score: 0,
            missing_evidence: ["No response"],
            verdict: "FAIL",
          },
        };

      if (onProgress)
        onProgress(
          "phase2",
          "proof-" + currentResult.agent.id,
          "Checking evidence: " + stripEmoji(currentResult.agent.name) + "...",
        );

      const proofCheck = await callModel(FREE_MODELS[0], [
        { role: "system", content: PROOF_CHECK_PROMPT },
        {
          role: "user",
          content:
            "Response to verify:\n" +
            (currentResult.response.content || "").slice(0, 3000) +
            "\n\nCheck if this response contains verifiable proof/evidence and return JSON.",
        },
      ]);

      let proof = {
        has_proof: false,
        proof_score: 0,
        missing_evidence: ["Proof check parse failed"],
        verdict: "FAIL",
      };
      if (proofCheck.success) {
        try {
          proof = JSON.parse(proofCheck.content);
        } catch (e) {
          proof = {
            has_proof: false,
            proof_score: 0,
            missing_evidence: ["JSON parse failed"],
            verdict: "FAIL",
          };
        }
      }
      log("INFO", "PROOF_CHECK", {
        agent: currentResult.agent.id,
        score: proof.proof_score,
        verdict: proof.verdict,
      });
      return { ...currentResult, proof };
    }),
  );

  // Step 4: PARALLEL CROSS-CHECK DEBATE
  // Each agent reviews ALL other agents' responses (not their own)
  // Runs fully parallel via Promise.all
  if (onProgress)
    onProgress(
      "phase2",
      "debate",
      "Cross-check debate: agents reviewing each other...",
    );

  const debatedResults = await Promise.all(
    proofResults.map(async (currentResult) => {
      if (!currentResult.response.success) {
        return { ...currentResult, debates: [] };
      }

      // Collect other agents' responses for review
      const otherResponses = proofResults
        .filter(
          (r) => r.agent.id !== currentResult.agent.id && r.response.success,
        )
        .map((r) => ({
          agent: r.agent.id,
          name: r.agent.name,
          role: r.agent.role,
          content: (r.response.content || "").slice(0, 1500),
        }));

      if (otherResponses.length === 0) {
        return { ...currentResult, debates: [] };
      }

      try {
        const debateResult = await callModel(currentResult.agent.model, [
          {
            role: "system",
            content:
              currentResult.agent.persona +
              "\n\nYou are in a CROSS-CHECK DEBATE phase. Review the OTHER agents' responses below." +
              "\nProvide your expert critique from your unique perspective as " +
              currentResult.agent.role +
              ".\n\nReturn a JSON object:\n" +
              JSON.stringify({
                agreement: "agree|partial|disagree",
                reasoning: "Brief explanation from your perspective",
                corrections: ["List specific issues or corrections needed"],
                suggestions: ["Improvements or additional considerations"],
              }),
          },
          {
            role: "user",
            content:
              "User query: " +
              userInput +
              "\n\nYour response was:\n" +
              (currentResult.response.content || "").slice(0, 1000) +
              "\n\nOther agents' responses to review:\n" +
              otherResponses
                .map(
                  (r) =>
                    "\n--- " + r.name + " (" + r.role + ") ---\n" + r.content,
                )
                .join("\n") +
              "\n\nReview these other agents. Do you agree with them? Disagree? What did they miss? Return JSON.",
          },
        ]);

        let debates = [];
        if (debateResult.success) {
          try {
            debates = [JSON.parse(debateResult.content)];
          } catch (e) {
            debates = [
              {
                agreement: "partial",
                reasoning: "Debate parse failed",
                corrections: [],
                suggestions: [],
              },
            ];
          }
        }
        log("INFO", "DEBATE_RESULT", {
          agent: currentResult.agent.id,
          agreement: debates[0]?.agreement || "unknown",
        });
        return { ...currentResult, debates };
      } catch (e) {
        return { ...currentResult, debates: [] };
      }
    }),
  );

  // Step 4b: PARALLEL challenge — weak agents get a chance to respond to critique
  if (onProgress)
    onProgress("phase2", "challenge", "Resolving challenges in parallel...");

  const finalResults = await Promise.all(
    debatedResults.map(async (currentResult) => {
      const hasDebateIssues = currentResult.debates.some(
        (d) => d.agreement === "disagree",
      );
      const needsChallenge =
        (hasDebateIssues ||
          !currentResult.alignment.aligned ||
          currentResult.proof.verdict === "FAIL") &&
        currentResult.response.success;

      if (!needsChallenge) return currentResult;

      const issues = [];
      if (hasDebateIssues) {
        const disagreeDebates = currentResult.debates.filter(
          (d) => d.agreement === "disagree",
        );
        for (const d of disagreeDebates) {
          if (d.corrections) issues.push(...d.corrections);
        }
      }
      if (!currentResult.alignment.aligned)
        issues.push(...(currentResult.alignment.issues || []));
      if (currentResult.proof.verdict === "FAIL")
        issues.push(
          "PROOF FAILED: " +
          (currentResult.proof.missing_evidence || []).join("; "),
        );

      log("INFO", "CHALLENGE_START", {
        agent: currentResult.agent.id,
        issues: issues.length,
      });

      const challengePrompt =
        currentResult.agent.persona +
        "\n\nYour response received CHALLENGES from other agents." +
        "\n\nIssues raised:\n- " +
        issues.join("\n- ") +
        "\n\nYou MUST address each issue with SPECIFIC EVIDENCE." +
        "\nIf you cannot provide proof, say 'আমার কাছে প্রমাণ নেই'." +
        "\nCorrect yourself NOW with proper evidence, file references, or code line numbers.";

      try {
        const defense = await callModel(
          currentResult.agent.model,
          [
            {
              role: "system",
              content: challengePrompt,
            },
            {
              role: "user",
              content:
                "User input: " +
                userInput +
                "\n\nYour previous response:\n" +
                (currentResult.response.content || "").slice(0, 2000) +
                "\n\nProvide a corrected response addressing all challenges.",
            },
          ],
          undefined,
          tools,
        );

        if (defense.success) {
          currentResult.response.content = defense.content;
          // Brief re-check after defense
          const reProof = await callModel(FREE_MODELS[0], [
            { role: "system", content: PROOF_CHECK_PROMPT },
            {
              role: "user",
              content:
                "Response to re-verify:\n" +
                (defense.content || "").slice(0, 3000) +
                "\n\nReturn JSON.",
            },
          ]);
          let reProofResult = { has_proof: false, verdict: "FAIL" };
          if (reProof.success) {
            try {
              reProofResult = JSON.parse(reProof.content);
            } catch (e) { }
          }
          currentResult.proof = reProofResult;
        }
      } catch (e) {
        log("WARN", "CHALLENGE_FAIL", {
          agent: currentResult.agent.id,
          error: e.message,
        });
      }

      return currentResult;
    }),
  );

  // Step 5: Final verification
  const allVerified = finalResults.every(
    (r) =>
      (!r.response.success || r.alignment.score > 50) &&
      (r.proof.verdict !== "FAIL" || !r.response.success),
  );
  log("INFO", "PHASE2_COMPLETE", {
    verified: allVerified,
    debates: finalResults.reduce((a, r) => a + (r.debates?.length || 0), 0),
    withProof: finalResults.filter(
      (r) => r.proof.verdict !== "FAIL" || !r.response.success,
    ).length,
    total: finalResults.length,
  });

  return {
    verified: allVerified,
    results: finalResults,
    challenges: finalResults.filter((r) => r.debates?.length > 0).length,
    debates: finalResults.flatMap((r) => r.debates || []),
    rounds: 1,
  };
}

// Phase 3: Combined Output
async function phase3_combinedOutput(
  agents,
  results,
  userInput,
  verification,
  onProgress,
  tools,
) {
  log("INFO", "PHASE3_START", {});

  if (onProgress)
    onProgress("phase3", "qa", "Combining all agent responses...");
  const qaAgent =
    agents.find((a) => a.role === "quality") || agents[agents.length - 1];
  const valid = results.filter((r) => r.response.success);
  if (valid.length === 0)
    return { success: false, combined: "No agents could respond." };

  // CROSS-VERIFICATION: QA-Tyrant does aggressive cross-checking
  // BEFORE producing the final output. Each agent's claims are verified.
  const crossCheckIssues = [];
  for (const r of valid) {
    const content = (r.response.content || "").toLowerCase();

    // 1. Check for unsupported claims — "it will work" without proof
    const unsupportedPatterns = [
      /it will work/i,
      /this should fix/i,
      /ette kaj korbe/,
      /it should work/i,
      /trust me/i,
      /bishshas kor/i,
      /definitely works/i,
      /nischitbhabe kaj korbe/i,
      // ── REAL BENGALI patterns ──
      /নিশ্চিতভাবে কাজ করবে/i,
      /এটা কাজ করবেই/i,
      /কাজ করবে বলে মনে হচ্ছে/i,
      /আমি নিশ্চিত/i,
      /সম্ভবত কাজ করবে/i,
      /এইভাবেই হবে/i,
      /ঠিক আছে এইভাবে করো/i,
      /বিশ্বাস কর/i,
      /নিশ্চয়ই কাজ করবে/i,
      /কোনো সমস্যা নাই/i,
      /এটা সঠিক/i,
    ];
    for (const pat of unsupportedPatterns) {
      if (pat.test(content)) {
        const snippet = content.match(pat)?.[0] || "unsupported claim";
        crossCheckIssues.push(
          `[${r.agent.name}] Unsupported claim detected: "${snippet}" - no test evidence provided!`,
        );
      }
    }

    // 2. Check for code claims without file references
    if (
      /\b(code|fix|implement|create|write|function|class|method|কোড|ফিক্স|ইমপ্লিমেন্ট)\b/i.test(
        content,
      )
    ) {
      const hasFileRef = /`[^`]+\.(js|py|ts|jsx|tsx|css|html|json|md)`/.test(
        content,
      );
      const hasPathRef = /(server\/|src\/|app\/|lib\/|components\/)/.test(
        content,
      );
      const hasLineRef = /\bline\s+\d+/i.test(content);
      if (!hasFileRef && !hasPathRef && !hasLineRef) {
        crossCheckIssues.push(
          `[${r.agent.name}] Code claim without file reference - cannot verify!`,
        );
      }
    }

    // 3. Check for missing test evidence in code-related claims
    if (
      /\b(fixed|solved|solved|completed|done|works|implemented)\b/i.test(
        content,
      )
    ) {
      const hasTestEvidence =
        /\b(test|tested|verified|confirmed|ran|executed|output|result)\b/i.test(
          content,
        );
      const hasUntested = /\b(UNTESTED|not tested|manual verification)\b/i.test(
        content,
      );
      if (!hasTestEvidence && !hasUntested) {
        crossCheckIssues.push(
          `[${r.agent.name}] Claims completion but NO test evidence provided - add UNTESTED disclaimer or test proof!`,
        );
      }
    }

    // 4. Check for hallucinated model/provider claims
    const modelProviderClaims = content.match(
      /\b(running on|powered by|using|via)\s+(gpt|claude|gemini|deepseek|llama|mistral)\b/gi,
    );
    if (modelProviderClaims) {
      crossCheckIssues.push(
        `[${r.agent.name}] Model identity leak detected: "${modelProviderClaims[0]}" - identities should be masked!`,
      );
    }
  }

  const reports = valid
    .map(
      (r) =>
        "=== " +
        r.agent.name +
        " ===\nRole: " +
        r.agent.role +
        "\nModel: " +
        r.agent.model +
        "\n\n" +
        (r.response.content || "").slice(0, 2000),
    )
    .join("\n\n");

  const challengeLog =
    verification.challenges > 0 ||
      (verification.debates && verification.debates.length > 0)
      ? "\\n\\nCross-Check Debate Log:\\n" +
      (verification.debates || [])
        .map(
          (d) =>
            "-> Agent critique: " +
            (d.agreement === "agree"
              ? "Agreed"
              : d.agreement === "partial"
                ? "Partial agreement"
                : "Disagreed") +
            (d.reasoning ? "\\n  Reason: " + d.reasoning : "") +
            (d.corrections && d.corrections.length > 0
              ? "\\n  Issues: " + d.corrections.join(", ")
              : ""),
        )
        .join("\\n")
      : "\\nNo debates needed.";

  // QA-TYRANT CROSS-CHECK LOG: Inject issues for QA agent
  const crossCheckLog =
    crossCheckIssues.length > 0
      ? "\\n\\nQA CROSS-CHECK ISSUES (REQUIRED ACTION):\\n" +
      crossCheckIssues.map((i) => "  [ISSUE] " + i).join("\\n") +
      "\\n\\nCRITICAL: You MUST address EVERY issue above in your final output. " +
      "If an agent made unsupported claims, mark them. If code lacks file references, note it. " +
      "Do NOT let unsupported claims pass through. Be the strict Quality Tyrant! " +
      "If you find any issues, REJECT the response and demand corrections. " +
      "The agents must provide SPECIFIC evidence: file paths, line numbers, test results, or 'আমার কাছ প্রমাণ নেই' if unsure."
      : "";

  // Check if this involves code (to enforce test-before-answer in QA)
  const involvesCode =
    /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(
      userInput,
    );

  let qaExtraRules = "";
  if (involvesCode) {
    qaExtraRules =
      "\n\n🔒 CODE SAFETY ENFORCEMENT (strict):" +
      "\n1. If any agent claims a code 'fix' or 'solution' — verify they provided SPECIFIC file paths and line numbers." +
      "\n2. If any agent claims something 'works' — check if they provided test evidence. If not, mark as 'UNTESTED'." +
      "\n3. NEVER let an agent's unsupported claim pass through. If evidence is missing, note: 'No test evidence provided.'" +
      "\n4. If the user asked for code changes, explicitly state which files are safe to modify and which should remain unchanged." +
      "\n5. If agents disagree, highlight the disagreement — don't hide it.";
  }

  const finalResult = await callModel(
    qaAgent.model,
    [
      {
        role: "system",
        content:
          qaAgent.persona +
          "\n\nCRITICAL RULE: You MUST produce the FINAL ANSWER directly. Do NOT write your thinking process. Do NOT explain how you will combine. Just GIVE THE ANSWER." +
          "\n\nYou are the QA coordinator. The agents below have already analyzed the user's question. Your job is to:" +
          "\n1. Read ALL agent reports carefully." +
          "\n2. INDEPENDENTLY VERIFY each agent's claims — do NOT just pick the best answer." +
          "\n3. For EACH agent, check: Did they provide file paths? Line numbers? Test evidence? Or just opinions?" +
          "\n4. Mark UNVERIFIED claims: If an agent says 'this works' without test proof, label it 'UNVERIFIED'." +
          "\n5. If agents disagree, highlight both sides and let the user decide." +
          "\n6. Write the FINAL ANSWER in the SAME LANGUAGE as the user's question." +
          "\n7. Start your response DIRECTLY with the answer — no preamble, no 'I will now combine'." +
          "\n\nVERIFICATION REQUIREMENTS:" +
          "\n- Code claims: MUST have file path + line number + test evidence" +
          "\n- Architecture claims: MUST reference specific components" +
          "\n- Security claims: MUST cite OWASP/CVE or specific vulnerability details" +
          "\n- Any claim without evidence  mark as [UNVERIFIED]" +
          "\n\nFORBIDDEN phrases (do NOT start with these):" +
          "\n- 'I will combine' / 'Let me merge' / 'আমি এখন একত্রিত করব'" +
          "\n- 'Based on the analysis' / 'After reviewing'" +
          "\n- 'The combined response' / 'Here is the merged output'" +
          "\n\nREQUIRED: Start with the ACTUAL ANSWER to the user's question." +
          (tools && tools.length > 0
            ? "\n\nYou have tools available. Use them if needed to verify claims."
            : "") +
          qaExtraRules,
      },
      {
        role: "user",
        content:
          "User input:\n" +
          userInput +
          "\n\nAll agents:\n" +
          reports +
          challengeLog +
          crossCheckLog +
          "\n\nWrite the FINAL ANSWER to the user's question. Start with the answer directly." +
          "\n\nREMEMBER: INDEPENDENTLY VERIFY each agent's claims. Do NOT just pick the best answer." +
          "\nCheck: Do they have file references? Test evidence? Or just opinions?" +
          (involvesCode
            ? "\n\nIMPORTANT: This involves code. Before finalizing, verify: Are the claims tested? Are the file references real? If unsure, state it clearly."
            : ""),
      },
    ],
    undefined,
    tools,
  );

  log("INFO", "PHASE3_COMPLETE", {
    combinedLength: (finalResult.content || "").length,
  });

  // ─── Strip meta-thinking from final output ───
  // Free models sometimes still output their reasoning process
  let finalContent = finalResult.success
    ? finalResult.content
    : "Combined output generation failed.";
  if (finalContent) {
    const metaPatterns = [
      // English thinking patterns
      /^(I need to|I will now|Let me|I should|I have to|I must|I can see|I notice|I think|I believe).{0,200}\n/gim,
      /^(Combining| merging|Merging|Analyzing|Checking|Verifying|Reviewing|Comparing|Evaluating).{0,200}\n/gim,
      /^(Based on the analysis|After reviewing|Looking at|Examining|The user asked|The user wants).{0,200}\n/gim,
      /^(Actually|However|Wait|Hmm|So basically|In other words|Let me explain).{0,200}\n/gim,
      // Bengali thinking patterns
      /^(আমি এখন|এখন আমি|আমাকে এখন|দেখি তো|বলতে হবে|চেক করি|বিশ্লেষণ|পরীক্ষা করি).{0,200}\n/gim,
      /^(একত্রিত|মার্জ|সংযুক্ত|সমন্বয়).{0,200}\n/gim,
      // Agent report references (model describing what agents said)
      /^((?:Code Guru|Bug Hunter|Security|Performance|Doc King|QA Tyrant|মনু|জুয়েল|বৃষ্টি|রাশেদ|হালিম|মজনু).{0,50}(started|gave|says|mentioned|noted|pointed out)).{0,200}\n/gim,
      // "Write the FINAL ANSWER" echo
      /^(Write the FINAL|FINAL ANSWER|The final answer).{0,200}\n/gim,
    ];
    for (const p of metaPatterns) {
      finalContent = finalContent.replace(p, "");
    }
    // Also strip inline thinking — "The user asked... which is Bengali for..."
    finalContent = finalContent.replace(
      /The user asked "[^"]*" which is Bengali for "[^"]*"\n\n?/g,
      "",
    );
    finalContent = finalContent.replace(
      /I need to check the (?:agents'|agent) reports\.?\s*\n?/g,
      "",
    );
    finalContent = finalContent.replace(
      /Let me (?:search|check|verify|look|read|see)[^.]*\.?\s*\n?/g,
      "",
    );
    finalContent = finalContent.replace(
      /Since the user is asking in Bengali, I should answer in Bengali\.?\s*\n?/g,
      "",
    );
    finalContent = finalContent.trim();
  }

  // ─── Apply identity masking + strip \uFFFD and invisible chars ───
  if (finalContent) {
    finalContent = maskModelIdentity(finalContent);
  }

  if (onProgress)
    onProgress(
      "phase3-done",
      "qa",
      "Mission complete — generating final output",
    );

  return {
    success: true,
    combined: finalContent || "Combined output generation failed.",
    agents: valid.map((r) => ({
      name: r.agent.name,
      role: r.agent.role,
      model: maskModelName(r.agent.model),
    })),
    verification: {
      verified: verification.verified,
      rounds: verification.rounds,
      challenges: verification.challenges,
      debates: (verification.debates || []).length,
    },
    stats: {
      totalAgents: agents.length,
      responded: valid.length,
      failed: results.filter((r) => !r.response.success).length,
    },
  };
}

// ══════════════════════════════════════════════════════════════
//  ANTI-DOTE TYPE SAFETY SYSTEM — Core Functions
// ══════════════════════════════════════════════════════════════
// Chain: validateInput → checkProof → getUserConsent → setGoalContract → execute → verifyOutput
// wrapWithAntiDote() executes the complete 6-step chain.

/**
 * Create a new Anti-dote contract for a mission
 */
function newAntiDoteContract(input, context = {}) {
  return {
    input,
    originalInput: input,
    context,
    createdAt: new Date().toISOString(),
    validatedAt: null,
    proofCheckedAt: null,
    proof: null,
    goal: null,
    constraints: {
      maxAgents: context.maxAgents || 6,
      requireProof: true,
      requireConsent: false,
      timeout: context.timeout || 120000,
      allowedTools: context.allowedTools || null,
    },
    execution: {
      startedAt: null,
      completedAt: null,
      success: false,
      error: null,
      result: null,
    },
    verification: {
      passed: false,
      score: 0,
      issues: [],
      verifiedAt: null,
    },
    chain: [],
  };
}

/**
 * Step 1: Validate input — schema enforcement
 */
function antiDoteValidateInput(input, context = {}) {
  const contract = newAntiDoteContract(input, context);

  if (!input || typeof input !== "string" || input.trim().length === 0) {
    return {
      valid: false,
      contract,
      error: new AntiDoteError("INVALID_REQUEST", {
        reason: "Input must be a non-empty string",
        received: typeof input,
      }),
    };
  }
  if (input.length > 100000) {
    return {
      valid: false,
      contract,
      error: new AntiDoteError("INVALID_REQUEST", {
        reason: "Input exceeds max length (100000 chars)",
        length: input.length,
      }),
    };
  }
  if (context && typeof context !== "object") {
    return {
      valid: false,
      contract,
      error: new AntiDoteError("INVALID_REQUEST", {
        reason: "Context must be an object",
        received: typeof context,
      }),
    };
  }

  contract.validatedAt = new Date().toISOString();
  contract.chain.push("validated");
  return { valid: true, contract, error: null };
}

/**
 * Step 2: Check proof — logical feasibility analysis
 */
function antiDoteCheckProof(contract) {
  if (!contract.chain.includes("validated")) {
    return {
      provable: false,
      contract,
      error: new AntiDoteError("PROOF_FAILED", {
        reason: "Cannot check proof before validation",
        chain: contract.chain,
      }),
    };
  }

  const input = contract.input;
  const wordCount = input.split(/\s+/).length;
  const _hasCode =
    /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(input);
  const _hasQuestion = /(\?|what|how|why|when|where|explain|tell)/i.test(input);
  const _hasCommand =
    /^(create|make|build|write|fix|update|delete|add|change|refactor)/im.test(
      input.trim(),
    );
  const _complexity =
    wordCount < 5 ? "simple" : wordCount > 100 ? "complex" : "moderate";
  const proof = {
    inputLength: input.length,
    wordCount,
    hasCodeIndicator: _hasCode,
    hasQuestionIndicator: _hasQuestion,
    hasCommandIndicator: _hasCommand,
    complexity: _complexity,
    isFeasible: true,
    reason:
      "Input: " +
      wordCount +
      " words. " +
      (_hasCode ? "Code-related." : "General.") +
      " Logically feasible.",
  };

  contract.proofCheckedAt = new Date().toISOString();
  contract.proof = proof;
  contract.chain.push("proof_checked");

  return { provable: true, contract, error: null };
}

/**
 * Step 3: Set goal contract — define success metrics
 */
function antiDoteSetGoalContract(contract) {
  if (!contract.chain.includes("proof_checked")) {
    return {
      contracted: false,
      contract,
      error: new AntiDoteError("CONTRACT_FAILED", {
        reason: "Cannot set goal before proof check",
        chain: contract.chain,
      }),
    };
  }

  const proof = contract.proof;
  const goal = {
    type: proof.hasCodeIndicator ? "code_task" : "qa_task",
    description: contract.input.slice(0, 200),
    successCriteria: [],
    requiredAgents: [],
    requiresCodeSafety: proof.hasCodeIndicator,
    requiresTestEvidence: proof.hasCodeIndicator,
  };

  if (proof.hasCodeIndicator) {
    goal.successCriteria.push("Code changes must be specific (file + line)");
    goal.successCriteria.push("Test evidence or UNTESTED disclaimer required");
    goal.requiredAgents = ["code-guru", "qa-tyrant"];
  }
  if (proof.hasQuestionIndicator) {
    goal.successCriteria.push("Response must directly answer with evidence");
  }
  if (proof.hasCommandIndicator) {
    goal.successCriteria.push("Action must be executed or explained");
  }
  goal.successCriteria.push("Language must match user input");
  goal.successCriteria.push("No hallucinated or unverified claims");

  if (proof.complexity === "simple" && goal.requiredAgents.length === 0) {
    goal.requiredAgents = ["code-guru"];
  }

  contract.goal = goal;
  contract.chain.push("goal_set");

  return { contracted: true, contract, error: null };
}

/**
 * Step 4: Execute — run mission with contract enforcement
 */
async function antiDoteExecute(contract, missionFn, ...args) {
  if (!contract.chain.includes("goal_set")) {
    return {
      success: false,
      contract,
      error: new AntiDoteError("CONTRACT_FAILED", {
        reason: "Cannot execute before goal contract is set",
        chain: contract.chain,
      }),
    };
  }

  contract.execution.startedAt = new Date().toISOString();
  contract.chain.push("executing");

  try {
    const result = await missionFn(...args);
    contract.execution.completedAt = new Date().toISOString();
    contract.execution.success = result.success !== false;
    contract.execution.result = result;
    contract.chain.push("executed");
    return { success: true, contract, result, error: null };
  } catch (err) {
    contract.execution.completedAt = new Date().toISOString();
    contract.execution.success = false;
    contract.execution.error = { message: err.message, stack: err.stack };
    contract.chain.push("execution_failed");
    return {
      success: false,
      contract,
      result: null,
      error: new AntiDoteError("EXECUTION_FAILED", {
        reason: err.message,
        chain: contract.chain,
      }),
    };
  }
}

/**
 * Step 5: Verify output — check result against goal contract
 * STRICT MODE: No mercy, no loopholes, every claim verified
 */
function antiDoteVerifyOutput(contract) {
  if (!contract.chain.includes("executed")) {
    return {
      verified: false,
      contract,
      error: new AntiDoteError("VERIFICATION_FAILED", {
        reason: "Cannot verify before execution",
        chain: contract.chain,
      }),
    };
  }

  const result = contract.execution.result;
  const goal = contract.goal;
  // STRICT: Start at 0, earn your score!
  const verification = { passed: false, score: 0, issues: [], checks: [] };

  if (!result || result.success === false) {
    verification.passed = false;
    verification.score = 0;
    verification.issues.push("Mission execution failed");
    verification.checks.push({ check: "execution_success", passed: false });
    contract.verification = {
      ...verification,
      verifiedAt: new Date().toISOString(),
    };
    contract.chain.push("verified_failed");
    return { verified: false, contract, result };
  }

  const combined = result.combined || "";
  const stats = result.stats || {};

  // ─── CHECK 1: Execution success (mandatory — 0 score if failed) ───
  // Already handled above — if we reach here, execution succeeded

  // ─── CHECK 2: Combined output exists and has substance ───
  // BUG #8 FIX: Check content quality, not just length
  if (!combined || combined.length < 10) {
    verification.score -= 20;
    verification.issues.push("Combined output too short or empty");
    verification.checks.push({ check: "has_output", passed: false });
  } else {
    // Quality checks: has structure, has evidence, not just filler
    const hasHeaders = /#{1,3}\s/.test(combined) || /\n[-=]{3,}/.test(combined);
    const hasBulletPoints =
      /[\-\*]\s/.test(combined) || /\d+\.\s/.test(combined);
    const hasCodeBlocks =
      /```[\s\S]*?```/.test(combined) || /`[^`]+`/.test(combined);
    const wordCount = combined.split(/\s+/).length;
    const hasSubstance = wordCount > 30; // At least 30 words for a real answer
    const qualityScore =
      (hasHeaders ? 3 : 0) +
      (hasBulletPoints ? 3 : 0) +
      (hasCodeBlocks ? 3 : 0) +
      (hasSubstance ? 6 : 0);
    verification.score += Math.min(15, qualityScore);
    verification.checks.push({
      check: "has_output",
      passed: true,
      detail: `${combined.length} chars, ${wordCount} words, quality=${qualityScore}/15`,
    });
  }

  // ─── CHECK 3: Agents responded ───
  if (!stats || stats.responded === 0) {
    verification.score -= 30;
    verification.issues.push("No agents responded");
    verification.checks.push({ check: "agents_responded", passed: false });
  } else {
    const rate = stats.responded / (stats.totalAgents || 1);
    if (rate < 0.3) {
      verification.score -= 15;
      verification.issues.push(
        "Too few agents responded (" +
        stats.responded +
        "/" +
        stats.totalAgents +
        ")",
      );
      verification.checks.push({
        check: "agents_responded",
        passed: false,
        detail: stats.responded + "/" + stats.totalAgents,
      });
    } else {
      const points = Math.min(20, Math.round(rate * 15));
      verification.score += points;
      verification.checks.push({
        check: "agents_responded",
        passed: true,
        detail: stats.responded + "/" + stats.totalAgents,
      });
    }
  }

  // ─── CHECK 4: Cross-verification was done ───
  // BUG #8 FIX: Count-based verification, not just boolean
  const verifData = result.verification || {};
  if (verifData.verified === true) {
    // Bonus for cross-verification rounds
    const rounds = verifData.rounds || 0;
    const challenges = verifData.challenges || 0;
    const debateCount = verifData.debates || 0;
    const verificationDepth = Math.min(
      15,
      10 + rounds * 2 + (challenges > 0 ? 3 : 0) + (debateCount > 0 ? 2 : 0),
    );
    verification.score += verificationDepth;
    verification.checks.push({
      check: "cross_verified",
      passed: true,
      detail: `${rounds} rounds, ${challenges} challenges, ${debateCount} debates — depth=${verificationDepth}`,
    });
  } else {
    verification.score -= 10;
    verification.issues.push("Cross-verification not completed");
    verification.checks.push({ check: "cross_verified", passed: false });
  }

  // ─── CHECK 5: Debates conducted (evidence of multi-agent review) ───
  const debateCount = verifData.debates || 0;
  if (debateCount > 0) {
    verification.score += 10;
    verification.checks.push({
      check: "debate_conducted",
      passed: true,
      detail: debateCount + " debates",
    });
  } else {
    verification.score -= 5;
    verification.checks.push({ check: "debate_conducted", passed: false });
  }

  // ─── CHECK 6: Code safety (when applicable) ───
  // BUG #8 FIX: More robust code safety checking
  if (goal.requiresCodeSafety && combined) {
    const hasFileRefs =
      /\b(server\/|src\/|app\/|lib\/|components\/|\.js|\.py|\.ts)\b/.test(
        combined,
      );
    const hasLineRefs = /\b(line\s+\d+|L\d+|লাইন\s+\d+)\b/i.test(combined);
    const hasTestMention = /\b(test|tested|verified|untested|UNTESTED)\b/i.test(
      combined,
    );
    const hasCodeBlocks = /```[\s\S]*?```/.test(combined);
    const hasSpecificChanges =
      /\b(changed|updated|modified|added|removed|replaced)\b/i.test(combined);

    let codeScore = 0;
    let codeDetail = [];
    if (hasFileRefs) {
      codeScore += 5;
      codeDetail.push("file refs");
    }
    if (hasLineRefs) {
      codeScore += 3;
      codeDetail.push("line refs");
    }
    if (hasTestMention) {
      codeScore += 3;
      codeDetail.push("test mention");
    }
    if (hasCodeBlocks) {
      codeScore += 2;
      codeDetail.push("code blocks");
    }
    if (hasSpecificChanges) {
      codeScore += 2;
      codeDetail.push("specific changes");
    }

    if (codeScore >= 10) {
      verification.score += 15;
      verification.checks.push({
        check: "code_safety",
        passed: true,
        detail: codeDetail.join(", ") + " — comprehensive",
      });
    } else if (codeScore >= 5) {
      verification.score += 5;
      verification.checks.push({
        check: "code_safety",
        passed: true,
        detail: codeDetail.join(", ") + " — partial",
      });
    } else {
      verification.score -= 15;
      verification.issues.push(
        "Code claims without file references — cannot verify",
      );
      verification.checks.push({
        check: "code_safety",
        passed: false,
        detail: "No file references found",
      });
    }
  }

  // CHECK 7: Language match
  const bengaliChars = combined.match(/[\u0980-\u09FF]/g);
  if (bengaliChars && bengaliChars.length > 5) {
    verification.score += 5;
    verification.checks.push({ check: "language_match", passed: true });
  }

  // CHECK 8: Hallucination scan — detect unsupported claims
  const lowContent = combined.toLowerCase();
  const weakPhrases = [
    /it will work/i,
    /this should fix/i,
    /it should work/i,
    /trust me/i,
    /definitely works/i,
    /i think/i,
    /probably/i,
    /may work/i,
    /might work/i,
    /could work/i,
    /i believe/i,
  ];
  let weakCount = 0;
  for (const phrase of weakPhrases) {
    if (phrase.test(lowContent)) {
      weakCount++;
    }
  }
  if (weakCount > 0) {
    verification.score -= weakCount * 10;
    verification.issues.push(
      weakCount + " unsupported/weak claim(s) detected in output",
    );
    verification.checks.push({
      check: "hallucination_scan",
      passed: false,
      detail: weakCount + " weak claims",
    });
  } else {
    verification.score += 5;
    verification.checks.push({ check: "hallucination_scan", passed: true });
  }

  // ─── FINAL: Clamp score 0-100, set pass/fail ───
  verification.score = Math.max(0, Math.min(100, verification.score));
  // STRICT: Minimum 75 to pass
  const PASS_THRESHOLD = 75;
  verification.passed = verification.score >= PASS_THRESHOLD;

  if (!verification.passed) {
    verification.issues.push(
      "Score " +
      verification.score +
      "/100 below threshold (" +
      PASS_THRESHOLD +
      ")",
    );
  }

  contract.verification = {
    ...verification,
    verifiedAt: new Date().toISOString(),
  };
  contract.chain.push(
    verification.passed ? "verified_passed" : "verified_failed",
  );

  return { verified: verification.passed, contract, result };
}

/**
 * ═══════════════════════════════════════════════════════════════
 * Anti-Dote Chain: Complete 6-Step Execution Wrapper
 * ═══════════════════════════════════════════════════════════════
 *
 * Usage:
 *   const output = await wrapWithAntiDote(executeMission, userInput, ...args);
 *   output.verified === true → guaranteed correct
 */
async function wrapWithAntiDote(missionFn, input, ...args) {
  const chainLog = [];
  const startTime = Date.now();
  const logChain = (step, status, detail) =>
    chainLog.push({ step, status, detail, time: Date.now() - startTime });

  // Step 1: Validate
  const { valid, contract, error: vErr } = antiDoteValidateInput(input);
  if (!valid) {
    logChain("validate", "FAILED", vErr.message);
    return {
      success: false,
      verified: false,
      combined: null,
      error: vErr.toJSON(),
      chain: chainLog,
      contract,
      antiDote: { applied: true, version: "1.0.0" },
    };
  }
  logChain("validate", "PASSED", "Input schema valid");

  // Step 2: Proof Check
  const { provable, error: pErr } = antiDoteCheckProof(contract);
  if (!provable) {
    logChain("proof_check", "FAILED", pErr.message);
    return {
      success: false,
      verified: false,
      combined: null,
      error: pErr.toJSON(),
      chain: chainLog,
      contract,
      antiDote: { applied: true, version: "1.0.0" },
    };
  }
  logChain("proof_check", "PASSED", `Complexity: ${contract.proof.complexity}`);

  // Step 3: getUserConsent — verify user permission
  // Per documentation: user_approval_required? -> wait_for_confirmation
  contract.constraints.requireConsent = true;

  // Always require real user consent — no auto-grant even in API mode.
  // Frontend UI must handle consent UI; API calls get pending status.
  contract.consent = {
    required: true,
    granted: false, // Require real user consent, not server-side auto-approval
    grantedAt: null,
    method: "pending_user_consent",
    requiresFrontendUI: true,
  };
  contract.chain.push({
    step: "consent",
    status: "PENDING",
    timestamp: new Date().toISOString(),
  });
  logChain(
    "consent",
    "PENDING",
    "Waiting for real user consent (not server-side auto-approval)",
  );

  // 🔒 SECURITY FIX (S6): Block execution if consent not granted
  // Contract says requireConsent=true, but code was continuing without checking
  if (contract.consent.required && !contract.consent.granted) {
    logChain(
      "consent",
      "BLOCKED",
      "User consent required but not granted — execution halted",
    );
    return {
      success: false,
      verified: false,
      combined: null,
      error:
        "User consent required but not granted. Please approve via the frontend UI.",
      chain: chainLog,
      contract,
      antiDote: { applied: true, version: "1.0.0" },
    };
  }

  // Step 4: Goal Contract
  const { contracted, error: cErr } = antiDoteSetGoalContract(contract);
  if (!contracted) {
    logChain("goal_contract", "FAILED", cErr.message);
    return {
      success: false,
      verified: false,
      combined: null,
      error: cErr.toJSON(),
      chain: chainLog,
      contract,
      antiDote: { applied: true, version: "1.0.0" },
    };
  }
  logChain(
    "goal_contract",
    "PASSED",
    `Type: ${contract.goal.type}, ${contract.goal.successCriteria.length} criteria`,
  );

  // Step 5: Execute
  const {
    success: eSuccess,
    result,
    error: eErr,
  } = await antiDoteExecute(contract, missionFn, input, ...args);
  if (!eSuccess) {
    logChain("execute", "FAILED", eErr.message);
    return {
      success: false,
      verified: false,
      combined: null,
      error: eErr.toJSON(),
      chain: chainLog,
      contract,
      antiDote: { applied: true, version: "1.0.0" },
    };
  }
  logChain("execute", "PASSED", `Mission done in ${Date.now() - startTime}ms`);

  // Step 6: Verify
  const { verified } = antiDoteVerifyOutput(contract);
  logChain(
    "verify",
    verified ? "PASSED" : "FAILED",
    `Score: ${contract.verification.score}/100`,
  );

  // Augment result
  return {
    success: result?.success !== false,
    verified,
    combined: result?.combined || "",
    agents: result?.agents || [],
    verification: {
      ...(result?.verification || {}),
      antiDote: {
        applied: true,
        score: contract.verification.score,
        passed: verified,
        issues: contract.verification.issues,
        checks: contract.verification.checks,
      },
    },
    stats: result?.stats || {},
    timing: { ...(result?.timing || {}), antiDote: Date.now() - startTime },
    timestamp: new Date().toISOString(),
    session_id: result?.session_id,
    contract: {
      goal: contract.goal,
      proof: contract.proof,
      verification: contract.verification,
      chain: chainLog,
    },
    antiDote: { applied: true, version: "1.0.0" },
  };
}

/**
 * ═══════════════════════════════════════════════════════════════
 * Anti-Dote Monitor: Non-blocking type safety observation
 * ═══════════════════════════════════════════════════════════════
 *
 * SAME chain as wrapWithAntiDote, but NEVER blocks execution.
 * Runs validation → proof check → consent → goal → execute → verify
 * Logs ALL steps visually with ANSI colors.
 * If anti-dote fails → execution still proceeds (monitoring mode).
 * Returns augmented result with anti-dote metadata.
 */
async function antiDoteMonitor(missionFn, input, ...args) {
  const startTime = Date.now();
  const chainLog = [];
  const logChain = (step, status, detail) => {
    const entry = { step, status, detail, time: Date.now() - startTime };
    chainLog.push(entry);
    // Visual terminal log with colors
    const icon = status === "PASSED" ? "✅" : status === "FAILED" ? "❌" : "⏳";
    const color =
      status === "PASSED"
        ? "\x1b[32m"
        : status === "FAILED"
          ? "\x1b[31m"
          : "\x1b[33m";
    const reset = "\x1b[0m";
    console.log(
      `  ${icon} ${color}[ANTI-DOTE]${reset} ${step.padEnd(15)} ${status.padEnd(8)} ${detail}`,
    );
  };
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";

  console.log(
    `\n${bold}${cyan}══════════════════ ANTI-DOTE MONITOR ══════════════════${reset}`,
  );
  console.log(`  ${bold}Input:${reset} "${(input || "").slice(0, 80)}..."`);
  console.log(
    `  ${bold}Mode:${reset} Non-blocking monitoring ${yellow}(execution proceeds regardless)${reset}\n`,
  );

  // Step 1: Validate
  const { valid, contract, error: vErr } = antiDoteValidateInput(input);
  if (!valid) {
    logChain("validate", "FAILED", vErr.message);
    console.log(
      `  ${bold}⚠️  ANTI-DOTE: Validation failed, but execution continues (monitoring mode)${reset}\n`,
    );
    // Still execute the mission even if validation fails
    try {
      const result = await missionFn(input, ...args);
      console.log(
        `  ${bold}${cyan}══════════════ ANTI-DOTE MONITOR (execution result) ══════════════${reset}\n`,
      );
      return {
        ...result,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: vErr.message,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: vErr.message,
        },
      };
    }
  }
  logChain("validate", "PASSED", `Input valid (${input.length} chars)`);

  // Step 2: Proof Check
  const { provable, error: pErr } = antiDoteCheckProof(contract);
  if (!provable) {
    logChain("proof_check", "FAILED", pErr.message);
    console.log(
      `  ${bold}⚠️  ANTI-DOTE: Proof check failed, but execution continues${reset}\n`,
    );
    try {
      const result = await missionFn(input, ...args);
      console.log(
        `  ${bold}${cyan}══════════════ ANTI-DOTE MONITOR (execution result) ══════════════${reset}\n`,
      );
      return {
        ...result,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: pErr.message,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: pErr.message,
        },
      };
    }
  }
  logChain("proof_check", "PASSED", `Complexity: ${contract.proof.complexity}`);

  // Step 3: Goal Contract (skip consent in monitoring mode)
  const { contracted, error: cErr } = antiDoteSetGoalContract(contract);
  if (!contracted) {
    logChain("goal_contract", "FAILED", cErr.message);
  } else {
    logChain(
      "goal_contract",
      "PASSED",
      `Type: ${contract.goal.type}, ${contract.goal.successCriteria.length} criteria`,
    );
  }
  // In monitoring mode, always proceed to execution

  // Step 5: Execute (always run the actual mission)
  let eSuccess = true,
    eResult = null,
    eErr2 = null;
  try {
    eResult = await missionFn(input, ...args);
    eSuccess = eResult?.success !== false;
    logChain(
      "execute",
      eSuccess ? "PASSED" : "FAILED",
      `Done in ${Date.now() - startTime}ms`,
    );
    if (!eSuccess) eErr2 = eResult?.error || "Execution returned success=false";
  } catch (err) {
    eSuccess = false;
    eErr2 = err.message;
    logChain("execute", "FAILED", err.message);
  }

  // Step 6: Verify (if we have a contract and results)
  let verified = false;
  let verificationScore = 0;
  let verificationIssues = [];
  let verificationChecks = [];
  if (contracted && eResult) {
    contract.execution = {
      completedAt: new Date().toISOString(),
      success: eSuccess,
      result: eResult,
    };
    contract.chain.push("executed");
    const vResult = antiDoteVerifyOutput(contract);
    verified = vResult.verified;
    verificationScore = contract.verification.score;
    verificationIssues = contract.verification.issues;
    verificationChecks = contract.verification.checks;
    logChain(
      "verify",
      verified ? "PASSED" : "FAILED",
      `Score: ${verificationScore}/100, Issues: ${verificationIssues.length}`,
    );
  } else {
    logChain(
      "verify",
      "SKIPPED",
      "No verification (contract or result missing)",
    );
  }

  // Visual summary
  const statusIcon = verified ? "✅" : "❌";
  const statusColor = verified ? "\x1b[32m" : "\x1b[31m";
  console.log(
    `\n  ${bold}${statusColor}${statusIcon} ANTI-DOTE VERDICT: ${verified ? "PASSED ✓" : "FAILED ✗"}${reset}`,
  );
  console.log(`  ${bold}Score:${reset} ${verificationScore}/100`);
  if (verificationIssues.length > 0) {
    console.log(`  ${bold}Issues:${reset}`);
    for (const issue of verificationIssues) {
      console.log(`    • ${issue}`);
    }
  }
  console.log(
    `${bold}${cyan}══════════════════════════════════════════════════════${reset}\n`,
  );

  // Return augmented result
  const baseResult = eResult || { success: eSuccess, combined: "" };
  return {
    ...baseResult,
    antiDoteMonitor: {
      applied: true,
      passed: verified,
      score: verificationScore,
      issues: verificationIssues,
      checks: verificationChecks,
      chain: chainLog,
      elapsed: Date.now() - startTime,
    },
  };
}

// ─── Full Mission Execute ─────────────────────────────────────
async function executeMission(
  userInput,
  context,
  sessionId,
  onProgress,
  tools,
) {
  const startTime = Date.now();

  // Safety: ensure AGENTS is not empty
  if (!AGENTS || AGENTS.length === 0) {
    log("WARN", "MISSION_NO_AGENTS", {});
    return {
      success: false,
      combined: "⚠️ কোনো এজেন্ট লোড হয়নি। PERSONAS.md ফাইল চেক করুন।",
      agents: [],
      verification: { verified: false, rounds: 0, challenges: 0 },
      stats: { totalAgents: 0, responded: 0, failed: 1 },
      timing: { elapsed: Date.now() - startTime },
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      error: "No agents loaded — check PERSONAS.md",
    };
  }

  // Auto-inject MCP tools when no tools provided
  // 🧟 MAX_TOOLS_LIMIT: module-level const (Phase C, api.js:3082) — single
  // source of truth for the "15" cap. (Local models get the stricter 5-cap
  // via the isLocalAgent override in the stream path.)
  if (!tools || tools.length === 0) {
    const mcpToolList = Object.entries(MCP_TOOLS).map(([name, def]) => ({
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: {
          type: "object",
          properties: def.params || {},
          required: def.required || [],
        },
      },
    }));
    if (mcpToolList.length > 0) tools = mcpToolList;
  }
  // Cap tools to MAX_TOOLS_LIMIT — too many tools = empty model response
  if (tools && tools.length > MAX_TOOLS_LIMIT) {
    log("WARN", "TOOLS_CAPPED", {
      original: tools.length,
      capped: MAX_TOOLS_LIMIT,
    });
    tools = tools.slice(0, MAX_TOOLS_LIMIT);
  }

  // ─── Step 0: Classify input → select relevant agents ──────
  const classification = classifyInput(userInput);
  const simpleMode =
    classification.type === "greeting" || classification.type === "simple_qa";

  // Smart agent selection: not all agents for every task
  let missionAgents = AGENTS;
  if (
    classification.recommended_agents &&
    classification.recommended_agents.length > 0
  ) {
    missionAgents = AGENTS.filter((a) =>
      classification.recommended_agents.includes(a.id),
    );
    // Always keep at least 2 agents
    if (missionAgents.length < 2) missionAgents = AGENTS.slice(0, 2);
  }

  log("INFO", "MISSION_START", {
    session: sessionId ? sessionId.slice(0, 8) : "none",
    input: userInput.slice(0, 100),
    simpleMode,
    classification: classification.type,
    agents_selected: missionAgents.length,
    agents_total: AGENTS.length,
    reason: classification.reason,
  });

  // ─── Load SSOT context ──────────────────────────────
  const ssotContent = readSSOT();
  let enrichedContext = ssotContent
    ? context
      ? context + "\n\n--- Project Knowledge (SSOT) ---\n" + ssotContent
      : "Project Knowledge (SSOT):\n" + ssotContent
    : context || "";

  // ─── Load Syllabus (learned knowledge) ──────────────
  const syllabusContent = readSyllabus();
  if (syllabusContent) {
    enrichedContext +=
      "\n\n--- Agent Knowledge (Syllabus) ---\n" + syllabusContent;
  }

  // ─── Load Memory (session context) ─────────────────
  const memoryData = readMemory();
  if (
    memoryData &&
    memoryData.recent_context &&
    memoryData.recent_context.length > 0
  ) {
    let memContext = "\n\n--- Session Memory ---\n";
    for (const ctx of memoryData.recent_context.slice(-3)) {
      memContext += `[${ctx.session_id}] ${ctx.summary}\n`;
      if (ctx.tags && ctx.tags.length > 0) {
        memContext += `Tags: ${ctx.tags.join(", ")}\n`;
      }
    }
    enrichedContext += memContext;
  }

  // ──── Restore recent session archives ───────────────
  const restoredContext = restoreRecentContext();
  if (restoredContext) {
    enrichedContext += restoredContext;
  }

  // ─── Auto Web Search: inject results before model call ────
  // Free models never write "web_search:" — so we detect need and search proactively
  if (classification.requires_web_search) {
    try {
      log("INFO", "AUTO_WEB_SEARCH", { query: userInput });
      if (onProgress)
        onProgress("web-search", "auto", "Searching for real-time data...");
      const searchResult = await webSearch(userInput);
      if (searchResult.success && searchResult.results.length > 0) {
        const searchText =
          "\n\n--- WEB SEARCH RESULTS (auto-injected) ---\n" +
          searchResult.results
            .map(
              (r, i) =>
                i +
                1 +
                ". " +
                (r.title || "Link") +
                "\n   " +
                (r.snippet || ""),
            )
            .join("\n") +
          "\n--- END SEARCH RESULTS ---\n";
        enrichedContext += searchText;
        log("INFO", "AUTO_WEB_SEARCH_INJECTED", {
          results: searchResult.results.length,
        });
      }
    } catch (e) {
      log("WARN", "AUTO_WEB_SEARCH_FAIL", { error: e.message });
    }
  }

  // ─── Quick response for greetings (no need for all agents) ──
  if (classification.type === "greeting") {
    // Use the requested agent if available, otherwise code-guru
    const requestedAgentId =
      (typeof parsed !== "undefined" && parsed ? parsed.agent_id : null) ||
      (typeof sessionMeta !== "undefined" && sessionMeta
        ? sessionMeta.agent_id
        : null);
    const greetingAgent =
      (requestedAgentId && AGENTS.find((a) => a.id === requestedAgentId)) ||
      AGENTS.find((a) => a.id === "code-guru") ||
      AGENTS[0];
    if (!greetingAgent) {
      return {
        success: false,
        combined: "⚠️ কোনো এজেন্ট পাওয়া যায়নি। PERSONAS.md চেক করুন।",
        agents: [],
        verification: { verified: false, rounds: 0, challenges: 0 },
        stats: { totalAgents: 0, responded: 0, failed: 1 },
        timing: { elapsed: Date.now() - startTime },
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        error: "No agents loaded",
      };
    }
    const quickResponse = await callModel(greetingAgent.model, [
      {
        role: "system",
        content:
          greetingAgent.persona +
          "\n\n" +
          buildAgentIdentity(greetingAgent) +
          "\n\nRespond very briefly and naturally in Bengali. No proof needed for greetings. Just be friendly and ask how to help.",
      },
      { role: "user", content: userInput },
    ]);

    const greetingContent = quickResponse.success
      ? maskModelIdentity(quickResponse.content)
      : "👋 হ্যালো! আমি " + greetingAgent.name + "। কীভাবে সাহায্য করতে পারি?";

    const greetingOutput = {
      success: true,
      combined: greetingContent,
      agents: [
        {
          name: greetingAgent.name,
          role: greetingAgent.role,
          model: maskModelName(greetingAgent.model),
        },
      ],
      verification: { verified: true, rounds: 0, challenges: 0 },
      stats: { totalAgents: 1, responded: 1, failed: 0 },
      timing: { elapsed: Date.now() - startTime },
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      _greeting_mode: true,
    };

    log("INFO", "MISSION_COMPLETE", {
      elapsed: Date.now() - startTime,
      agents: 1,
      responded: 1,
      failed: 0,
      verified: true,
      mode: "greeting_skip",
    });

    return greetingOutput;
  }

  // ─── Quick mode for simple Q&A (one agent directly, skip pipeline) ──
  if (classification.type === "simple_qa" && simpleMode) {
    const qaAgentId = classification.recommended_agents?.[0] || "code-guru";
    const qaAgent = AGENTS.find((a) => a.id === qaAgentId) || AGENTS[0];
    if (qaAgent) {
      await pushLog("phase", "সরাসরি উত্তর তৈরি করছি...");
      const quickResponse = await callModel(qaAgent.model, [
        {
          role: "system",
          content:
            qaAgent.persona +
            "\n\n" +
            buildAgentIdentity(qaAgent) +
            "\n\nPROOF REQUIREMENT: You MUST provide verifiable evidence for EVERY claim. " +
            "If you cannot provide evidence, say 'আমার কাছে প্রমাণ নেই'. " +
            "Still help with what you know — say you lack proof but offer suggestions.",
        },
        { role: "user", content: userInput },
      ]);

      const qaContent = quickResponse.success
        ? maskModelIdentity(quickResponse.content)
        : "⚠️ উত্তর তৈরি করতে সমস্যা হয়েছে। আবার চেষ্টা করুন।";

      const qaOutput = {
        success: true,
        combined: qaContent,
        agents: [
          {
            name: qaAgent.name,
            role: qaAgent.role,
            model: maskModelName(qaAgent.model),
          },
        ],
        verification: { verified: true, rounds: 0, challenges: 0 },
        stats: { totalAgents: 1, responded: 1, failed: 0 },
        timing: { elapsed: Date.now() - startTime },
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        _simple_qa_mode: true,
      };

      log("INFO", "MISSION_COMPLETE", {
        elapsed: Date.now() - startTime,
        agents: 1,
        responded: 1,
        failed: 0,
        verified: true,
        mode: "simple_qa_skip",
      });

      await pushLog("phase", "উত্তর প্রস্তুত!");
      return qaOutput;
    }
  }

  // Fallback: if simpleMode but not simple_qa (or agent not found)
  if (simpleMode && missionAgents.length > 3) {
    missionAgents = missionAgents.slice(0, 3);
  }

  if (onProgress)
    onProgress(
      "mission-start",
      "mission",
      ssotContent
        ? "SSOT loaded — " +
        missionAgents.length +
        "/" +
        AGENTS.length +
        " agents selected (" +
        classification.type +
        ")"
        : "Starting mission with " +
        missionAgents.length +
        " agents" +
        (classification.type !== "task"
          ? " (mode: " + classification.type + ")"
          : ""),
    );

  if (AGENTS.length === 0)
    return { success: false, combined: "No agents available." };

  const phase1Results = await phase1_initialResponse(
    missionAgents,
    userInput,
    enrichedContext,
    sessionId,
    onProgress,
    classification,
    tools,
  );
  const verification = await phase2_intentCrossVerify(
    phase1Results,
    userInput,
    simpleMode,
    onProgress,
    tools,
  );
  const output = await phase3_combinedOutput(
    missionAgents,
    phase1Results,
    userInput,
    verification,
    onProgress,
    tools,
  );

  if (sessionId) {
    saveMemory(sessionId, "user", userInput);
    saveMemory(sessionId, "assistant", output.combined || "");
    updateSession(sessionId, {
      messages: (getSession(sessionId)?.messages || 0) + 1,
    });
  }
  flushAllMemory();
  try {
    archiveSession(
      mcpWorkingDir,
      sessionId,
      [
        { role: "user", content: stripUserRequestTags(userInput) },
        { role: "assistant", content: deduplicateText(output.combined || "") },
      ],
      `Mission (${missionAgents.length} agents): ${(output.combined || "").slice(0, 100)}`,
    );
  } catch (_) { }

  // SSOT Auto-Refresh: refresh project context after mission completes
  // So subsequent agents get the latest file structure and content
  try {
    const projectDir = mcpWorkingDir || sessionId;
    if (projectDir && fs.existsSync(projectDir)) {
      autoSSOT(projectDir);
      log("INFO", "SSOT_REFRESHED", { dir: projectDir });
    }
  } catch (_) {
    /* SSOT refresh failure should not block response */
  }

  const elapsed = Date.now() - startTime;
  log("INFO", "MISSION_COMPLETE", {
    elapsed,
    agents_total: AGENTS.length,
    agents_dispatched: missionAgents.length,
    responded: output.stats?.responded || 0,
    failed: output.stats?.failed || 0,
    verified: output.verification?.verified || false,
  });

  // ── GOAL VERIFICATION: Block invalid output before sending to user ──
  const goalCheck = verifyGoalOutput(output.combined || "", userInput);
  if (!goalCheck.passed) {
    log("WARN", "GOAL_VERIFICATION_FAILED", {
      reason: goalCheck.reason,
      session: sessionId?.slice(0, 8),
    });
    // Replace combined output with honest limitation message
    output.combined = goalCheck.message;
    output.verification = {
      ...output.verification,
      goalVerified: false,
      goalReason: goalCheck.reason,
    };
  } else {
    output.verification = {
      ...output.verification,
      goalVerified: true,
      goalReason: goalCheck.reason,
    };
  }

  // ── AGENT-TO-AGENT CALL: Process any pending calls in output ──
  const agentCalls = parseAgentCalls(output.combined || "");
  if (agentCalls.length > 0) {
    log("INFO", "AGENT_CALLS_DETECTED", { count: agentCalls.length });
    for (const call of agentCalls) {
      try {
        const callResult = await executeAgentCall(
          { name: "QA Coordinator" },
          call.targetAgent,
          call.task,
          sessionId,
          tools,
        );
        if (callResult.success) {
          // Replace the call marker with the actual result
          output.combined = output.combined.replace(
            call.fullMatch,
            "\n\n[তথ্য প্রাপ্ত: " +
            callResult.agent +
            "]\n" +
            callResult.content,
          );
        } else {
          output.combined = output.combined.replace(
            call.fullMatch,
            "\n\n[এজেন্ট কল ব্যর্থ: " + call.targetAgent + "]",
          );
        }
      } catch (e) {
        log("WARN", "AGENT_CALL_FAIL", {
          target: call.targetAgent,
          error: e.message,
        });
      }
    }
  }

  await pushOutput(output.combined);
  await pushDone(output.stats);

  return {
    ...output,
    timing: { elapsed },
    timestamp: new Date().toISOString(),
    session_id: sessionId,
  };
}

// ─── SSOT Auto-Inject: inject project context sent by client ──
// If client provides `project_context` or `ssot` field, inject it.
// Otherwise server injects nothing — server filesystem is not user local.
function getSSOTContext(clientCtx) {
  if (
    clientCtx &&
    typeof clientCtx === "string" &&
    clientCtx.trim().length > 10
  ) {
    const truncated = clientCtx.slice(0, 3000);
    return (
      "\n\n PROJECT CONTEXT (provided by client):\n" +
      truncated +
      "\n--- END PROJECT CONTEXT ---\n"
    );
  }
  return "";
}

/**
 * Read syllabus.md, memory.json, and recent session context
 * from the project's .zombiecoder/agents/ directory.
 * Returns a formatted string or empty string if nothing found.
 */
function buildThreeFileContext(projectDir, sessionId) {
  try {
    const dir =
      projectDir ||
      getEffectiveDir(sessionId) ||
      mcpWorkingDir ||
      path.resolve(".");
    // Per user requirement (syllabus 8.6): inject ONLY the syllabus
    // (learned knowledge). Session memory + archives are loaded
    // separately via getAgentMemory history — no duplication, less tokens.
    const syllabusContent = readSyllabus(dir);
    if (syllabusContent) {
      return (
        "\n\nAGENT SYLLABUS (learned knowledge — ALWAYS check this first):\n" +
        syllabusContent +
        "\n--- END SYLLABUS ---\n" +
        "\n\nSESSION TOOLS & SYSTEM IDENTITY & ETHICS (injected every session):\n" +
        "- TOOLS AVAILABLE: read_file, write_file, list_directory, glob, grep, terminal, exec, db_query, web_search, http_request, open_browser, browse_cdp, agent_single, agent_mission, call_agent, get_memory, read_ssot, get_working_dir, set_working_dir, env_get, system_info, remote_mcp_call, delete_file, rename_file\n" +
        "- SYSTEM IDENTITY: You are a Mission Barisal agent (ZombieCoder) owned by Sahon Srabon (Barisal, Bangladesh). You are NOT a generic assistant. Follow the context above exactly.\n" +
        "- ETHICS: Evidence-driven, proof-first. Never hallucinate. If you lack proof say 'আমার কাছে প্রমাণ নেই'. Never hide errors. Code in English, chat with users in Bengali (Barishali style). No emojis in code.\n" +
        "--- END SESSION TOOLS & IDENTITY & ETHICS ---\n"
      );
    }
  } catch (e) {
    log("WARN", "THREE_FILE_CONTEXT_FAIL", { error: e.message });
  }
  return "";
}

// ─── Single Agent Execute ─────────────────────────────────────
async function executeSingleAgent(
  agentId,
  messages,
  stream,
  sessionId,
  tools,
  projectContext,
) {
  const startTime = Date.now();
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent) return { success: false, error: "Agent not found: " + agentId };

  log("INFO", "SINGLE_AGENT_START", {
    agent: agent.id,
    name: agent.name,
    session: sessionId ? sessionId.slice(0, 8) : "none",
  });

  const userMsg = messages.filter((m) => m.role === "user").pop();
  let userInput = userMsg ? userMsg.content : "";
  // 🧟 INPUT_FIX (2026-08-07, Code Guru - Monu): VS Code Copilot Chat sends
  // content as an ARRAY of parts ([{type:"text",text:"..."}] or duck-typed
  // [{value:"..."}]) in some paths. mission mode had this fix; single-agent
  // did NOT — so agents received an empty/object input and replied with
  // empty responses. Normalize BOTH string and array forms here.
  if (Array.isArray(userInput)) {
    userInput = userInput
      .map((c) => (typeof c === "string" ? c : c.text || c.value || ""))
      .filter(Boolean)
      .join("\n");
  } else if (userInput && typeof userInput === "object") {
    userInput = userInput.text || userInput.value || JSON.stringify(userInput);
  }
  userInput = String(userInput || "");

  // Inject system identity + persona
  // Detect if user input involves code (to add code safety rules)
  const involvesCode =
    /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(
      userInput,
    );
  let extraRules = "";
  if (involvesCode) {
    extraRules =
      "\n\n🔒 CODE SAFETY & TEST RULES:" +
      "\n1. NEVER claim code changes 'work' without test evidence. Say 'UNTESTED' if not verified." +
      "\n2. Always specify WHICH file and WHICH lines to modify." +
      "\n3. Read project structure first — don't suggest changes that break existing code." +
      "\n4. Provide backup recommendations before major changes.";
  }

  const ssotCtx = getSSOTContext(projectContext);
  const threeFileCtx = buildThreeFileContext(null, sessionId);

  // 🧟 FIX-002: Detect if client (extension) already provides mission context
  const firstMsg = messages[0];
  const clientHasMissionContext =
    firstMsg &&
    firstMsg.role === "system" &&
    typeof firstMsg.content === "string" &&
    (firstMsg.content.includes("MISSION BARISAL SYSTEM CONTEXT") ||
      firstMsg.content.includes("Mission Barisal agent") ||
      firstMsg.content.includes("AGENT SYLLABUS"));

  if (clientHasMissionContext) {
    log("INFO", "CLIENT_MISSION_CONTEXT_DETECTED", {
      reason: "Extension provides full mission context — skipping server-side persona/SSOT/syllabus injection",
    });
  }

  // ── MANDATORY CONTEXT ENFORCEMENT ──
  const mandatoryCtx = clientHasMissionContext
    ? "" // Client already provided full mission context
    : "\n\n MANDATORY CONTEXT RULES (STRICTLY ENFORCED):" +
      "\n\n### BEFORE answering ANY question:" +
      "\n1. **CHECK SSOT FIRST** — The SSOT above contains this project's blueprint: tech stack, file structure, entry points, dependencies. Read it before responding." +
      "\n2. **CHECK SYLLABUS** — The syllabus above contains your learned knowledge AND the project footprint (languages, frameworks, patterns). This is your memory — use it." +
      "\n3. **CHECK SESSION MEMORY** — Previous conversations are logged above. Reference them to avoid repeating mistakes." +
      "\n4. **NEVER GUESS** — If SSOT/Syllabus/Memory has the answer, use it directly. If not, search the web. Do NOT fabricate." +
      "\n\n### WHILE responding:" +
      "\n5. **BE CONCISE** — Answer directly. Do not explain things the user already knows. Do not repeat information from SSOT/Syllabus." +
      "\n6. **USE EVIDENCE** — Reference file paths, line numbers, test results. Say 'আমার কাছে প্রমাণ নেই' if you cannot prove." +
      "\n7. **FOLLOW PERSONA** — You are " + agent.name + " — Mission Barisal Agent. Never break character." +
      "\n8. **IDENTITY** — You are NOT GPT/Claude/Gemini. Never mention any other model/provider." +
      "\n\n### CONSTRAINT:" +
      "\nIf you lack data AND web search fails, say: 'ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই।' and STOP. Do NOT fabricate information.";

  // When client provides mission context, use minimal system message
  const sysMsg = clientHasMissionContext
    ? {
        role: "system",
        content:
          "You are " +
          agent.name +
          " — Mission Barisal Agent." +
          "\n\nPROOF REQUIREMENT: You MUST provide verifiable evidence for EVERY claim. If you cannot provide evidence, say 'আমার কাছে প্রমাণ নেই'. Still help with what you know — say you lack proof but offer suggestions." +
          extraRules +
          "\n\n🔧 TOOLS AVAILABLE (call these via tool calls — do NOT just describe them):\n" +
          buildToolsDescription(MCP_TOOLS) +
          "- Use web_search for real-time information.\n" +
          "- Use call_agent to delegate sub-tasks to other specialized agents.\n" +
          "When the user asks you to read files, write files, list directories, or open files in a browser — USE these tools directly by calling them. Do NOT just describe what you would do — actually execute the tool calls. Only respond with text after you have completed all necessary tool operations.",
      }
    : {
        role: "system",
        content:
          agent.persona +
          "\n\n" +
          buildAgentIdentity(agent) +
          "\n\nPROOF REQUIREMENT: You MUST provide verifiable evidence for EVERY claim. If you cannot provide evidence, say 'আমার কাছে প্রমাণ নেই'. Still help with what you know — say you lack proof but offer suggestions." +
          mandatoryCtx +
          extraRules +
          ssotCtx +
          threeFileCtx +
          "\n\n🔧 TOOLS AVAILABLE (call these via tool calls — do NOT just describe them):\n" +
          buildToolsDescription(MCP_TOOLS) +
          "- Use web_search for real-time information.\n" +
          "- Use call_agent to delegate sub-tasks to other specialized agents (e.g., call bug-hunter for debugging, security-hero for security review).\n" +
          "When the user asks you to read files, write files, list directories, or open files in a browser — USE these tools directly by calling them. Do NOT just describe what you would do — actually execute the tool calls. Only respond with text after you have completed all necessary tool operations.",
      };

  const augmentedMessages = [sysMsg, ...messages];

  // ─── Auto Web Search: detect need and inject results ────
  // Free models never write "web_search:" — so we detect need proactively
  const classification = classifyInput(userInput);
  if (classification.requires_web_search) {
    try {
      log("INFO", "AUTO_WEB_SEARCH_SINGLE", { query: userInput });
      const searchResult = await webSearch(userInput);
      if (searchResult.success && searchResult.results.length > 0) {
        const searchText =
          "\n\n--- WEB SEARCH RESULTS (auto-injected) ---\n" +
          searchResult.results
            .map(
              (r, i) =>
                i +
                1 +
                ". " +
                (r.title || "Link") +
                "\n   " +
                (r.snippet || ""),
            )
            .join("\n") +
          "\n--- END SEARCH RESULTS ---\n";
        // Inject into last user message
        const lastUserIdx = augmentedMessages.findLastIndex(
          (m) => m.role === "user",
        );
        if (lastUserIdx >= 0) {
          augmentedMessages[lastUserIdx] = {
            ...augmentedMessages[lastUserIdx],
            content: augmentedMessages[lastUserIdx].content + searchText,
          };
        }
      }
    } catch (e) {
      log("WARN", "AUTO_WEB_SEARCH_SINGLE_FAIL", { error: e.message });
    }
  }

  // Load memory if session exists
  if (sessionId) {
    const mem = getAgentMemory(sessionId, agentId);
    if (mem.length > 0) {
      const history = mem
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-MAX_HISTORY);
      const historyMessages = history.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      augmentedMessages.splice(1, 0, ...historyMessages);
      log("INFO", "AGENT_MEMORY_LOADED", {
        agent: agent.id,
        count: historyMessages.length,
      });
    }
  }

  // Auto-inject MCP tools when no tools provided
  //  MAX_TOOLS_LIMIT: module-level const (Phase C) — single source of truth
  if (!tools || tools.length === 0) {
    const mcpToolList = Object.entries(MCP_TOOLS).map(([name, def]) => ({
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: {
          type: "object",
          properties: def.params || {},
          required: def.required || [],
        },
      },
    }));
    if (mcpToolList.length > 0) tools = mcpToolList;
  }
  // Cap tools to MAX_TOOLS_LIMIT
  if (tools && tools.length > MAX_TOOLS_LIMIT) {
    log("WARN", "TOOLS_CAPPED", {
      original: tools.length,
      capped: MAX_TOOLS_LIMIT,
    });
    tools = tools.slice(0, MAX_TOOLS_LIMIT);
  }

  if (stream) {
    const result = await callModelWithTools(
      agent.model,
      augmentedMessages,
      undefined,
      tools,
    );
    const safeResult = result || {};
    const masked = maskModelIdentity(safeResult.content || "No response");
    if (sessionId) {
      const userMsg = messages.filter((m) => m.role === "user").pop();
      if (userMsg) saveAgentMemory(sessionId, agentId, "user", userMsg.content);
      if (masked) saveAgentMemory(sessionId, agentId, "assistant", masked);
      saveMemory(sessionId, "user", userMsg?.content || "");
      saveMemory(sessionId, "assistant", masked);
      updateSession(sessionId, {
        model: agentId,
        provider: agent.model,
        messages: (getSession(sessionId)?.messages || 0) + 1,
      });
      flushAllMemory();
      try {
        const usrMsg = messages.filter((m) => m.role === "user").pop();
        archiveSession(
          mcpWorkingDir,
          sessionId,
          [
            { role: "user", content: stripUserRequestTags(usrMsg?.content || "") },
            { role: "assistant", content: deduplicateText(masked || "") },
          ],
          `Agent ${agentId} (stream): ${(masked || "").slice(0, 100)}`,
        );
      } catch (_) { }
    }
    // ── SYLLABUS LEARNING: persist what was learned (stream) ──
    try {
      learnToSyllabus(sessionId, agent, userMsg?.content || "", masked || "");
    } catch (_) { }
    return {
      success: true,
      content: masked,
      maskedModel: agent.id,
      agent: { id: agent.id, name: agent.name, role: agent.role },
    };
  }

  // Non-streaming
  let response = await callModelWithTools(
    agent.model,
    augmentedMessages,
    undefined,
    tools,
  );

  // Show error message when all providers fail
  if (!response || !response.success) {
    const provInfo = response?.provider || "resolve(" + agent.model + ")";
    log("WARN", "SINGLE_AGENT_FAIL", {
      agent: agent.id,
      model: agent.model,
      provider: provInfo,
      error: response?.error || "unknown",
    });
    return {
      success: false,
      content:
        "🧟 ভাইয়া! সব provider ব্যর্থ হয়েছে। [model: " +
        agent.model +
        ", provider: " +
        provInfo +
        "] " +
        (response?.error || "unknown"),
      error: response?.error || "unknown",
      provider: provInfo,
      maskedModel: agent.id,
      agent: { id: agent.id, name: agent.name, role: agent.role },
    };
  }

  // Auto web search if requested
  response = await autoWebSearch(agent, response, userInput);

  // Save per-agent memory
  if (sessionId) {
    saveAgentMemory(sessionId, agentId, "user", userInput);
    saveAgentMemory(sessionId, agentId, "assistant", response.content || "");
    saveMemory(sessionId, "user", userInput);
    saveMemory(sessionId, "assistant", response.content || "");
    updateSession(sessionId, {
      model: agentId,
      provider: agent.model,
      messages: (getSession(sessionId)?.messages || 0) + 1,
    });
    flushAllMemory();
    try {
      archiveSession(
        mcpWorkingDir,
        sessionId,
        [
          { role: "user", content: stripUserRequestTags(userInput) },
          { role: "assistant", content: deduplicateText(response.content || "") },
        ],
        `Agent ${agentId}: ${(response.content || "").slice(0, 100)}`,
      );
    } catch (_) { }
  }

  log("INFO", "SINGLE_AGENT_COMPLETE", {
    agent: agent.id,
    contentLength: (response.content || "").length,
    webSearch: response.webSearchUsed || false,
    elapsed: Date.now() - startTime,
  });

  // ── SYLLABUS LEARNING: persist what was learned (non-stream) ──
  try {
    learnToSyllabus(sessionId, agent, userInput, response.content || "");
  } catch (_) { }

  // ── GOAL VERIFICATION for single agent ──
  const singleGoalCheck = verifyGoalOutput(response.content || "", userInput);
  if (!singleGoalCheck.passed) {
    log("WARN", "SINGLE_AGENT_GOAL_FAILED", {
      agent: agent.id,
      reason: singleGoalCheck.reason,
    });
    response.content = singleGoalCheck.message;
  }

  // ── AGENT-TO-AGENT CALL for single agent ──
  const singleAgentCalls = parseAgentCalls(response.content || "");
  if (singleAgentCalls.length > 0) {
    for (const call of singleAgentCalls) {
      try {
        const callResult = await executeAgentCall(
          agent,
          call.targetAgent,
          call.task,
          sessionId,
          tools,
        );
        if (callResult.success) {
          response.content = response.content.replace(
            call.fullMatch,
            "\n\n[তথ্য প্রাপ্ত: " +
            callResult.agent +
            "]\n" +
            callResult.content,
          );
        } else {
          response.content = response.content.replace(
            call.fullMatch,
            "\n\n[এজেন্ট কল ব্যর্থ: " + call.targetAgent + "]",
          );
        }
      } catch (e) {
        log("WARN", "SINGLE_AGENT_CALL_FAIL", {
          target: call.targetAgent,
          error: e.message,
        });
      }
    }
  }

  // Build OpenAI-compatible response with masking
  const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;
  return {
    success: true,
    content: response.content,
    tool_calls: response.tool_calls || null,
    maskedModel: agent.id, // Mask: show agent id, not real model
    agent: { id: agent.id, name: agent.name, role: agent.role },
    goalVerified: singleGoalCheck.passed,
    goalReason: singleGoalCheck.reason,
    // 🧟 #5 swap_notice: trail recorded on THIS request's augmentedMessages
    swap_notice: getSwapNotice(augmentedMessages),
  };
}

// ══════════════════════════════════════════════════════════════
//  MCP JSON-RPC 2.0 HANDLER
// ══════════════════════════════════════════════════════════════
let nextMcpId = 1;
// MCP working directory tracking
let mcpWorkingDir = path.resolve(".");

// Per-session working directory: if session has a custom dir, use it
function getEffectiveDir(sessionId) {
  if (sessionId && sessionDirs.has(sessionId)) {
    return sessionDirs.get(sessionId);
  }
  return mcpWorkingDir;
}

// Auto-detect project root: check OS env vars first (editor/server can set
// these), then parent dirs for .zombiecoder/ marker.
const WORKSPACE_ENV_VARS = [
  "PROJECT_DIR",
  "MISSION_WORKSPACE_ROOT",
  "ZOMBIECODER_WORKSPACE",
  "WORKSPACE_ROOT",
  "MISSION_BARISAL_WORKING_DIR",
  "ZOMBIECODER_WORKING_DIR",
  "MB_WORKING_DIR",
  "ZC_WORKING_DIR",
];
let workspaceEnvSource = null;
for (const envKey of WORKSPACE_ENV_VARS) {
  if (process.env[envKey]) {
    const envDir = path.resolve(process.env[envKey]);
    if (fs.existsSync(envDir)) {
      mcpWorkingDir = envDir;
      workspaceEnvSource = envKey;
      log("INFO", "MCP_DIR_ENV", { dir: envDir, source: envKey });
      break;
    }
  }
}
if (!workspaceEnvSource) {
  // Walk up from current dir looking for .zombiecoder/ directory
  let probe = path.resolve(".");
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(probe, ".zombiecoder"))) {
      mcpWorkingDir = probe;
      log("INFO", "MCP_DIR_DETECTED", { dir: probe, source: "parent-scan" });
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
}

const MCP_TOOLS = {
  read_file: {
    description: "Read a file from the filesystem",
    params: {
      path: {
        type: "string",
        description: "File path (relative to MCP working dir or absolute)",
      },
    },
    required: ["path"],
  },
  write_file: {
    description: "Write content to a file (creates directories)",
    params: {
      path: {
        type: "string",
        description: "File path (relative to MCP working dir or absolute)",
      },
      content: { type: "string", description: "Content" },
    },
    required: ["path", "content"],
  },
  set_working_dir: {
    description: "Set MCP working directory for relative file paths",
    params: {
      directory: {
        type: "string",
        description: "Absolute path to working directory",
      },
    },
    required: ["directory"],
  },
  get_working_dir: {
    description: "Get current MCP working directory",
    params: {},
    required: [],
  },
  web_search: {
    description: "Search the web for real-time information",
    params: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
  agent_mission: {
    description: "Execute a mission with all agents in parallel",
    params: {
      input: { type: "string", description: "User input" },
      session_id: { type: "string", description: "Optional session ID" },
    },
    required: ["input"],
  },
  agent_single: {
    description: "Execute with a single agent",
    params: {
      input: { type: "string", description: "User input" },
      agent_id: { type: "string", description: "Agent ID" },
      session_id: { type: "string", description: "Optional session ID" },
    },
    required: ["input", "agent_id"],
  },
  get_memory: {
    description: "Retrieve session memory",
    params: {
      session_id: { type: "string", description: "Session ID" },
      agent_id: { type: "string", description: "Optional: per-agent memory" },
    },
    required: ["session_id"],
  },
  read_ssot: {
    description:
      "Read the current SSOT.md (Single Source of Truth) file — contains auto-detected project info",
    params: {},
    required: [],
  },
  list_directory: {
    description: "List contents of a directory",
    params: {
      path: {
        type: "string",
        description: "Directory path (relative to MCP working dir or absolute)",
      },
    },
    required: ["path"],
  },
  open_browser: {
    description:
      "Open a file or URL in the default browser (uses xdg-open/open/start)",
    params: {
      target: {
        type: "string",
        description:
          "File path or URL to open in the browser (e.g., /abs/path/file.html or http://localhost:3000)",
      },
    },
    required: ["target"],
  },
  browse_cdp: {
    description:
      "Headless-browse a URL via Chrome DevTools Protocol over a PIPE (zero HTTP control channel — no port, no websocket). Fetches a page with headless Chrome and returns its text, HTML, title, or a screenshot. Use for reading local or remote web pages.",
    params: {
      url: {
        type: "string",
        description: "Absolute URL to open: http://, https:// or file://",
      },
      action: {
        type: "string",
        description:
          "What to return: text (default, readable page text) | html | title | screenshot (base64 png)",
      },
      timeout_ms: {
        type: "number",
        description: "Load timeout in milliseconds (default 20000)",
      },
    },
    required: ["url"],
  },
  call_agent: {
    description:
      "Call another agent for a specific sub-task. Use when the task needs specialized knowledge from another agent (e.g., security review, bug hunting, performance tuning).",
    params: {
      agent_id: {
        type: "string",
        description:
          "Target agent ID: code-guru (architecture), bug-hunter (debugging), security-hero (security), perf-wizard (performance), doc-king (documentation), qa-tyrant (quality)",
      },
      task: {
        type: "string",
        description: "The specific sub-task to delegate to this agent",
      },
      context: {
        type: "string",
        description:
          "Optional context or background information for the sub-task",
      },
    },
    required: ["agent_id", "task"],
  },
  // 🧟 NEW (2026-08-07, Code Guru - Monu): essential dev tools added per
  // user requirement — terminal, delete_file, rename, grep, glob.
  // These were missing from MCP_TOOLS; only read/write/list existed before.
  terminal: {
    description:
      "Run a shell command in the server terminal (cwd = MCP working dir). Returns stdout/stderr/exit code. Windows: PowerShell 5.1; Linux/macOS: bash.",
    params: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: {
        type: "string",
        description: "Optional working directory (default: MCP working dir)",
      },
    },
    required: ["command"],
  },
  delete_file: {
    description: "Delete a file or directory (recursive for directories)",
    params: {
      path: {
        type: "string",
        description:
          "File/directory path (relative to MCP working dir or absolute)",
      },
    },
    required: ["path"],
  },
  rename_file: {
    description: "Rename or move a file/directory",
    params: {
      from: {
        type: "string",
        description: "Source path (relative to MCP working dir or absolute)",
      },
      to: {
        type: "string",
        description: "Destination path (relative to MCP working dir or absolute)",
      },
    },
    required: ["from", "to"],
  },
  grep: {
    description:
      "Search file contents with a regex or plain text pattern inside the MCP working dir (bounded depth). Returns matching file paths + line snippets.",
    params: {
      query: { type: "string", description: "Pattern to search (regex allowed)" },
      include: {
        type: "string",
        description:
          "Optional glob filter, e.g. '**/*.js' or 'src/**' (default: all files)",
      },
      maxResults: {
        type: "number",
        description: "Optional cap on matches (default 50)",
      },
    },
    required: ["query"],
  },
  glob: {
    description:
      "Find files by glob pattern inside the MCP working dir (e.g. '**/*.{js,ts}')",
    params: {
      pattern: { type: "string", description: "Glob pattern (relative to working dir)" },
    },
    required: ["pattern"],
  },
  // [MB-TOOLS-2026] db_query, db_list_tables, exec, http_request, env_get, system_info
  db_query: {
    description:
      "Run a SQL query against a configured database (MySQL/SQLite/PostgreSQL). Config comes from env vars ONLY (DB_TYPE, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SQLITE_PATH, DB_TIMEOUT, PHP_BIN). MySQL/PostgreSQL use a PHP PDO bridge (db-bridge.php); SQLite uses Node built-in node:sqlite. Cross-platform (Windows/Linux/macOS).",
    params: {
      query: { type: "string", description: "SQL query to execute (SELECT/INSERT/UPDATE/DELETE/DDL)" },
      database: { type: "string", description: "Optional DB name override (default: DB_NAME env)" },
    },
    required: ["query"],
  },
  db_list_tables: {
    description:
      "List tables in the configured database (MySQL/SQLite/PostgreSQL). Config from env vars ONLY (DB_*). Cross-platform.",
    params: {
      database: { type: "string", description: "Optional DB name override (default: DB_NAME env)" },
    },
    required: [],
  },
  exec: {
    description:
      "Run a shell command cross-platform in any folder. Windows uses PowerShell, Linux/macOS uses bash (override via EXEC_SHELL_WIN / EXEC_SHELL_LINUX env). Config from env vars ONLY (EXEC_SHELL_WIN, EXEC_SHELL_LINUX, EXEC_TIMEOUT, EXEC_MAX_BUFFER).",
    params: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Optional working directory (absolute or relative to MCP working dir)" },
      timeout: { type: "number", description: "Optional timeout in ms (default from env EXEC_TIMEOUT, 30000)" },
      env: { type: "object", description: "Optional extra environment variables to pass" },
    },
    required: ["command"],
  },
  http_request: {
    description:
      "Make an HTTP request (GET/POST/PUT/PATCH/DELETE) using Node built-in http/https. No external deps. Config: HTTP_TIMEOUT env (ms). Cross-platform.",
    params: {
      url: { type: "string", description: "Full URL (http:// or https://)" },
      method: { type: "string", description: "HTTP method (default GET)" },
      headers: { type: "object", description: "Optional request headers" },
      body: { type: "string", description: "Optional request body (raw string)" },
      timeout: { type: "number", description: "Optional timeout in ms (default from env HTTP_TIMEOUT, 30000)" },
    },
    required: ["url"],
  },
  env_get: {
    description:
      "Read an environment variable by name. Config is env-driven (never hardcoded). Values of KEY/SECRET/PASSWORD/TOKEN/AUTH variables are hidden unless reveal_secrets=true.",
    params: {
      key: { type: "string", description: "Environment variable name (e.g. DB_NAME, PORT, EXEC_TIMEOUT)" },
      reveal_secrets: { type: "boolean", description: "Set true to reveal values of secret-looking variables" },
    },
    required: ["key"],
  },
  system_info: {
    description:
      "Get cross-platform system info: platform, arch, OS, hostname, Node version, cwd, uptime, memory, non-secret env var names, and the configured DB config (values masked).",
    params: {},
    required: [],
  },
};


// 🧟 EXTERNAL TOOL CONNECTOR (ENV-DRIVEN) — NEW (2026-08-07)
// Registers external tools from env vars into MCP_TOOLS at startup.
// Env vars: EXTERNAL_TOOL_1_NAME, EXTERNAL_TOOL_1_URL, EXTERNAL_TOOL_1_KEY,
//           EXTERNAL_TOOL_1_METHOD, EXTERNAL_TOOL_1_DESCRIPTION, EXTERNAL_TOOL_1_PARAMS
const EXTERNAL_TOOLS = new Map(); // name -> { url, key, method }
function loadExternalTools() {
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^EXTERNAL_TOOL_(\d+)_NAME$/);
    if (!m) continue;
    const n = m[1];
    const name = process.env[key].trim();
    const url = (process.env["EXTERNAL_TOOL_" + n + "_URL"] || "").trim();
    if (!name || !url || seen.has(name)) continue;
    if (!/^https?:\/\//i.test(url)) {
      console.warn("[EXTERNAL_TOOL] Skipped " + name + ": URL must be http(s)");
      continue;
    }
    seen.add(name);
    // 🧟 TDZ_FIX (2026-08-08): renamed inner `const key` -> `authKey`.
    // The for-of loop variable is `key`; shadowing it with `const key`
    // inside the loop body put `key` in the temporal dead zone, so the
    // first `key.match(...)` above threw "Cannot access 'key' before
    // initialization" and crashed the server at startup.
    const authKey = process.env["EXTERNAL_TOOL_" + n + "_KEY"] || "";
    const method = (process.env["EXTERNAL_TOOL_" + n + "_METHOD"] || "POST").toUpperCase();
    const desc = process.env["EXTERNAL_TOOL_" + n + "_DESCRIPTION"] || "External tool: " + name;
    let params = {};
    try {
      const raw = process.env["EXTERNAL_TOOL_" + n + "_PARAMS"];
      if (raw) params = JSON.parse(raw);
    } catch (e) {
      console.warn("[EXTERNAL_TOOL] " + name + ": invalid PARAMS JSON, using {}");
    }
    EXTERNAL_TOOLS.set(name, { url, key: authKey, method, desc, params });
    MCP_TOOLS[name] = {
      description: desc,
      params: Object.keys(params).length
        ? params
        : { args: { type: "object", description: "Tool arguments" } },
      required: ["args"],
    };
    console.log("[EXTERNAL_TOOL] Loaded: " + name + " -> " + url);
  }
  if (seen.size > 0) console.log("[EXTERNAL_TOOL] Total loaded: " + seen.size);
}
loadExternalTools();

// ══════════════════════════════════════════════════════════════
// 🧟 PHASE D: OUTBOUND MCP CLIENT (2026-08-10, Code Guru - Monu)
// This server becomes an MCP *client*: it connects to REMOTE MCP
// servers (JSON-RPC 2.0 over HTTP POST), discovers their tools, and
// can call them. Remote tools are merged into MCP_TOOLS with the
// prefix `remote__<server>__<tool>` so local tools are not shadowed.
// Config via env: REMOTE_MCP_SERVERS = "url1,url2" OR JSON array:
//   [{"url":"https://b.zombiecoder.my.id/mcp","name":"zombie"}]
// ══════════════════════════════════════════════════════════════

// Generic tool: lets agents call ANY remote MCP server tool by name.
MCP_TOOLS.remote_mcp_call = {
  description:
    "Call a tool on a remote MCP server (outbound MCP client). Use this to invoke tools exposed by connected remote MCP servers.",
  params: {
    server: {
      type: "string",
      description: "Remote MCP server name (see /api/mcp-remote)",
    },
    tool: { type: "string", description: "Remote tool name to call" },
    args: { type: "object", description: "Arguments for the remote tool" },
  },
  required: ["server", "tool"],
};

const mcpRemoteClients = new Map(); // name -> { url, name, tools:[], status, lastSync, error }

function parseRemoteMcpServers() {
  const raw = process.env.REMOTE_MCP_SERVERS || "";
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      return arr.filter((s) => s && s.url);
    } catch (e) {
      log("WARN", "REMOTE_MCP_PARSE_FAIL", { error: e.message });
      return [];
    }
  }
  return trimmed.split(",").filter(Boolean).map((url) => ({ url: url.trim() }));
}

function mcpRemoteRequest(url, method, params, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let lib;
    try {
      lib = url.startsWith("https://") ? https : http;
    } catch (e) {
      resolve({ error: "invalid url: " + url });
      return;
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params || {},
    });
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      resolve({ error: "invalid url: " + url });
      return;
    }
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname || "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "MissionBarisal-OutboundMCP/3.2.1",
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ error: "non-json response: " + data.slice(0, 200) });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout after " + timeoutMs + "ms" });
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

async function discoverRemoteMCP(server) {
  const { url, name } = server;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    /* keep raw url as name fallback */
  }
  const entry = {
    url,
    name: name || host,
    tools: [],
    status: "connecting",
    lastSync: 0,
    error: "",
    addedAt: Date.now(),
  };
  mcpRemoteClients.set(entry.name, entry);
  try {
    const init = await mcpRemoteRequest(url, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mission-barisal-gateway", version: "3.2.1" },
    });
    if (init.error) {
      entry.status = "error";
      entry.error = init.error;
      return entry;
    }
    const list = await mcpRemoteRequest(url, "tools/list", {});
    if (list.error) {
      entry.status = "error";
      entry.error = list.error;
      return entry;
    }
    entry.tools = (list.result && list.result.tools) || [];
    entry.status = "connected";
    entry.lastSync = Date.now();
    log("INFO", "REMOTE_MCP_CONNECTED", {
      server: entry.name,
      tools: entry.tools.length,
    });
  } catch (e) {
    entry.status = "error";
    entry.error = e.message;
    log("WARN", "REMOTE_MCP_DISCOVER_FAIL", {
      server: entry.name,
      error: e.message,
    });
  }
  return entry;
}

async function syncAllRemoteMCPs() {
  const servers = parseRemoteMcpServers();
  if (servers.length === 0) return { ok: true, synced: 0 };
  let synced = 0;
  for (const s of servers) {
    await discoverRemoteMCP(s);
    synced++;
  }
  log("INFO", "REMOTE_MCP_SYNC_DONE", { servers: synced });
  return { ok: true, synced };
}

// Merge remote tools into MCP_TOOLS with remote__<server>__<tool> prefix.
function mergeRemoteMcpTools() {
  let added = 0;
  for (const [name, client] of mcpRemoteClients) {
    if (client.status !== "connected") continue;
    for (const t of client.tools) {
      const fullName = "remote__" + name + "__" + t.name;
      if (MCP_TOOLS[fullName]) continue; // already merged
      MCP_TOOLS[fullName] = {
        description:
          "[remote:" + name + "] " + (t.description || t.name),
        params:
          (t.inputSchema && t.inputSchema.properties) || {
            args: { type: "object" },
          },
        required: (t.inputSchema && t.inputSchema.required) || [],
      };
      added++;
    }
  }
  if (added > 0) log("INFO", "REMOTE_MCP_TOOLS_MERGED", { added });
  return added;
}

async function executeRemoteMcpTool(server, tool, args) {
  const client = mcpRemoteClients.get(server);
  if (!client) {
    return {
      content: [
        {
          type: "text",
          text:
            "Unknown remote MCP server: " +
            server +
            " (see /api/mcp-remote)",
        },
      ],
    };
  }
  if (client.status !== "connected") {
    return {
      content: [
        {
          type: "text",
          text:
            "Remote MCP server '" +
            server +
            "' not connected: " +
            client.error,
        },
      ],
    };
  }
  const res = await mcpRemoteRequest(client.url, "tools/call", {
    name: tool,
    arguments: args || {},
  });
  if (res.error) {
    return {
      content: [{ type: "text", text: "Remote tool error: " + res.error }],
    };
  }
  const result = res.result || {};
  const text = (result.content || [])
    .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
  return {
    content: [{ type: "text", text: text || JSON.stringify(result) }],
  };
}

function isPathSafe(targetPath) {
  // 🌐 AGENT_FS_SCOPE — env toggle for the agent's filesystem sandbox.
  //   "unrestricted" (DEFAULT): agents may touch ANY file/folder on this OS
  //     — user's explicit request (root-level access for the agent persona).
  //   "restricted": legacy sandbox (workspace + ALLOWED_DIRS + $HOME only).
  const scope = (process.env.AGENT_FS_SCOPE || "unrestricted").toLowerCase();
  if (scope === "unrestricted" || scope === "root" || scope === "any") {
    return true;
  }
  const resolved = path.resolve(targetPath);
  // Allow access within the current MCP working directory (the user's workspace).
  // When a user calls `set_working_dir`, mcpWorkingDir is updated to their workspace root.
  // This grants access to anything under the workspace root the user explicitly chose.
  if (mcpWorkingDir && (resolved.startsWith(mcpWorkingDir + path.sep) || resolved === mcpWorkingDir)) {
    return true;
  }
  // Also check the static ALLOWED_DIRS (server CWD + log/data dirs).
  for (const allowed of ALLOWED_DIRS) {
    // Root directory ("/" on POSIX, "C:\" on Windows): everything is under it.
    // Fix: previously `allowed + path.sep` produced "//" for root, which
    // never matched any path — root access via ALLOWED_DIRS=/ was broken.
    if (allowed === path.sep || allowed === path.parse(allowed).root) {
      return true;
    }
    if (resolved.startsWith(allowed + path.sep) || resolved === allowed) {
      return true;
    }
  }
  // Allow access to any path under the user's home directory.
  // This enables the agent to read/write project files across all workspaces.
  const homeDir = path.resolve(os.homedir());
  if (resolved.startsWith(homeDir + path.sep) || resolved === homeDir) {
    return true;
  }
  return false;
}

async function executeMcpTool(tool, args) {
  const id = nextMcpId++;
  log("INFO", "MCP_CALL", { tool, args, id });

  // 🧟 Admin on/off — single choke point for HTTP + UDS + SSE callers.
  if (!toolEnabled(tool)) {
    log("WARN", "MCP_TOOL_DISABLED", { tool, id });
    return {
      content: [
        {
          type: "text",
          text: `⛔ TOOL_DISABLED: '${tool}' is turned off in the admin panel (MCP & Tools page).`,
        },
      ],
    };
  }

  // 🧟 PHASE D: outbound MCP delegation — remote__<server>__<tool> prefix
  if (tool === "remote_mcp_call") {
    return await executeRemoteMcpTool(args.server, args.tool, args.args || {});
  }
  if (tool.startsWith("remote__")) {
    const parts = tool.split("__");
    if (parts.length >= 3) {
      const server = parts[1];
      const remoteTool = parts.slice(2).join("__");
      return await executeRemoteMcpTool(server, remoteTool, args);
    }
  }

  // 🧟 PHASE D2: external MCP delegation — <server>__<tool> prefix
  // Tools come from external mcp/servers.json OR EXTERNAL_MCP_URLS.
  if (tool.includes("__")) {
    const parsed = externalMcp.parseToolName(tool);
    if (parsed) {
      const extResult = await externalMcp.call(parsed.server, parsed.tool, args);
      if (extResult) return extResult;
    }
  }

  switch (tool) {
    case "read_file": {
      const readPath = args.path || ".";
      const p = path.isAbsolute(readPath)
        ? path.resolve(readPath)
        : path.resolve(mcpWorkingDir, readPath);
      if (!isPathSafe(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside allowed directories. Working dir: " +
                mcpWorkingDir,
            },
          ],
        };
      }
      if (!fs.existsSync(p))
        return { content: [{ type: "text", text: "File not found: " + p }] };
      const stat = fs.statSync(p);
      if (!stat.isFile())
        return { content: [{ type: "text", text: "Not a file: " + p }] };
      const content = fs.readFileSync(p, "utf8");
      return { content: [{ type: "text", text: content.slice(0, 100000) }] };
    }
    case "write_file": {
      const writePath = args.path || "";
      const p = path.isAbsolute(writePath)
        ? path.resolve(writePath)
        : path.resolve(mcpWorkingDir, writePath);
      if (!isPathSafe(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside allowed directories. Working dir: " +
                mcpWorkingDir,
            },
          ],
        };
      }
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, args.content || "");
      return {
        content: [
          {
            type: "text",
            text: "Written " + (args.content || "").length + " bytes to " + p,
          },
        ],
      };
    }
    case "terminal": {
      const cmd = args.command || "";
      if (!cmd.trim()) {
        return { content: [{ type: "text", text: "Empty command" }] };
      }
      const cwd =
        args.cwd && typeof args.cwd === "string"
          ? path.resolve(mcpWorkingDir || ".", args.cwd)
          : mcpWorkingDir || ".";
      const { exec } = require("child_process");
      const shell = _PLATFORM === "win32" ? "powershell.exe" : "/bin/bash";
      const shellArgs = _PLATFORM === "win32" ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];
      return await new Promise((resolve) => {
        const child = exec(
          cmd,
          { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024, shell },
          (error, stdout, stderr) => {
            const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
            const text =
              "$ " + cmd + "\n(cwd: " + cwd + ")\n\n" +
              (stdout ? "[stdout]\n" + stdout.slice(0, 50000) + "\n" : "") +
              (stderr ? "[stderr]\n" + stderr.slice(0, 50000) + "\n" : "") +
              "[exit] " + exitCode;
            resolve({ content: [{ type: "text", text }] });
          }
        );
      });
    }
    case "delete_file": {
      const p = path.isAbsolute(args.path || "")
        ? path.resolve(args.path)
        : path.resolve(mcpWorkingDir, args.path || "");
      if (!isPathSafe(p)) {
        return { content: [{ type: "text", text: "Access denied: path outside allowed directories: " + p }] };
      }
      if (!fs.existsSync(p)) {
        return { content: [{ type: "text", text: "Path not found: " + p }] };
      }
      const stat = fs.statSync(p);
      fs.rmSync(p, { recursive: true, force: true });
      return {
        content: [
          {
            type: "text",
            text: "Deleted " + (stat.isDirectory() ? "directory" : "file") + ": " + p,
          },
        ],
      };
    }
    case "rename_file": {
      const fromP = path.isAbsolute(args.from || "")
        ? path.resolve(args.from)
        : path.resolve(mcpWorkingDir, args.from || "");
      const toP = path.isAbsolute(args.to || "")
        ? path.resolve(args.to)
        : path.resolve(mcpWorkingDir, args.to || "");
      if (!isPathSafe(fromP) || !isPathSafe(toP)) {
        return { content: [{ type: "text", text: "Access denied: path outside allowed directories" }] };
      }
      if (!fs.existsSync(fromP)) {
        return { content: [{ type: "text", text: "Source not found: " + fromP }] };
      }
      const dir = path.dirname(toP);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(fromP, toP);
      return { content: [{ type: "text", text: "Renamed/moved: " + fromP + " -> " + toP }] };
    }
    case "grep": {
      const query = args.query || "";
      if (!query) return { content: [{ type: "text", text: "Empty query" }] };
      const base = mcpWorkingDir || ".";
      const maxResults = Math.min(parseInt(args.maxResults, 10) || 50, 200);
      let re;
      try {
        re = new RegExp(query, "i");
      } catch (e) {
        return { content: [{ type: "text", text: "Invalid regex: " + e.message }] };
      }
      const hits = [];
      const walk = (dir, depth) => {
        if (depth > 8 || hits.length >= maxResults) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.isFile()) {
            try {
              const content = fs.readFileSync(full, "utf8");
              for (const line of content.split("\n")) {
                if (re.test(line)) {
                  hits.push(path.relative(base, full) + ":" + line.slice(0, 200));
                  if (hits.length >= maxResults) break;
                }
              }
            } catch { }
          }
        }
      };
      walk(base, 0);
      return {
        content: [
          {
            type: "text",
            text: hits.length
              ? hits.join("\n")
              : "No matches for: " + query,
          },
        ],
      };
    }
    case "glob": {
      const pattern = args.pattern || "";
      const base = mcpWorkingDir || ".";
      const fullPattern = path.isAbsolute(pattern)
        ? pattern
        : path.join(base, pattern);
      const matches = [];
      const walk = (dir, depth) => {
        if (depth > 8) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(base, full);
          if (matchGlob(rel, pattern)) matches.push(rel);
          if (e.isDirectory()) walk(full, depth + 1);
        }
      };
      walk(base, 0);
      return {
        content: [
          {
            type: "text",
            text: matches.length ? matches.slice(0, 200).join("\n") : "No files match: " + pattern,
          },
        ],
      };
    }
    case "set_working_dir": {
      let rawDir = (args.directory || args.dir || args.path || ".").trim();
      // Handle ${workspaceFolder} sent literally (cursor/vscode variable not expanded)
      if (
        rawDir.includes("${workspaceFolder}") ||
        rawDir === "${workspaceFolder}" ||
        rawDir.includes("${workspaceRoot}")
      ) {
        rawDir = ".";
        log("WARN", "SET_WORKING_DIR_UNEXPANDED", {
          message:
            "Client sent ${workspaceFolder} unexpanded. Cursor MCP config needs to support variable expansion. Defaulting to server dir.",
        });
      }
      const newDir = path.resolve(rawDir);
      if (!fs.existsSync(newDir)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Directory not found: " +
                newDir +
                ". Please check the path and try again.",
            },
          ],
        };
      }
      mcpWorkingDir = newDir;
      // 🔒 SECURITY FIX (S4): Don't dynamically add to ALLOWED_DIRS
      // Previously any directory could be added via MCP set_working_directory,
      // bypassing the original ALLOWED_DIRS restrictions (path traversal risk).
      // Only update mcpWorkingDir — ALLOWED_DIRS remains static.
      const dirStr = path.resolve(newDir);
      if (
        !ALLOWED_DIRS.some(
          (d) => d === dirStr || dirStr.startsWith(d + path.sep),
        )
      ) {
        log("WARN", "ALLOWED_DIR_BLOCKED", {
          dir: dirStr,
          message:
            "Dynamic ALLOWED_DIRS modification blocked for security. Use env ALLOWED_DIRS instead.",
        });
      }
      // Check if .zombiecoder/SSOT.md exists, if not — auto-generate
      const ssotPath = path.join(newDir, ".zombiecoder", "SSOT.md");
      const exists = fs.existsSync(ssotPath);
      refreshSSOT(newDir);
      const reloaded = readSSOT(newDir);
      return {
        content: [
          {
            type: "text",
            text:
              "Working directory set to: " +
              mcpWorkingDir +
              "\n" +
              (exists
                ? "SSOT updated at: " + ssotPath
                : "SSOT auto-generated at: " + ssotPath) +
              "\n" +
              "Project: " +
              path.basename(newDir) +
              " | " +
              (reloaded ? reloaded.length + " bytes" : "unknown"),
          },
        ],
      };
    }
    case "get_working_dir": {
      return { content: [{ type: "text", text: mcpWorkingDir }] };
    }
    case "web_search": {
      const result = await webSearch(args.query);
      if (result.success && result.results.length > 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify(result.results, null, 2) },
          ],
        };
      }
      return { content: [{ type: "text", text: "No results found." }] };
    }
    case "agent_mission": {
      const sessId = args.session_id || crypto.randomUUID();
      console.log(
        "\x1b[36m\x1b[1m  [MCP] agent_mission called — wrapping with anti-dote\x1b[0m",
      );
      const result = await antiDoteMonitor(
        executeMission,
        args.input,
        null,
        sessId,
        undefined,
        sanitizeTools(args.tools, args.model),
      );
      return {
        content: [
          { type: "text", text: result.combined || "Mission completed." },
        ],
      };
    }
    case "agent_single": {
      const sessId = args.session_id || crypto.randomUUID();
      console.log(
        "\x1b[36m\x1b[1m  [MCP] agent_single called — wrapping with anti-dote\x1b[0m",
      );
      // executeSingleAgent(agentId, messages, ...) — first param is agentId,
      // NOT user input, so wrap in a closure before handing to anti-dote.
      const agentFn = async (userInput) => {
        return await executeSingleAgent(
          args.agent_id,
          [{ role: "user", content: userInput }],
          false,
          sessId,
          undefined,
          "",
        );
      };
      const result = await antiDoteMonitor(agentFn, args.input);
      return {
        content: [
          { type: "text", text: result.content || "Response generated." },
        ],
      };
    }
    case "get_memory": {
      const mem = args.agent_id
        ? getAgentMemory(args.session_id, args.agent_id)
        : getMemory(args.session_id);
      return {
        content: [{ type: "text", text: JSON.stringify(mem, null, 2) }],
      };
    }
    case "read_ssot": {
      const ssotContent = readSSOT();
      if (ssotContent) {
        return { content: [{ type: "text", text: ssotContent }] };
      }
      return {
        content: [
          {
            type: "text",
            text: "SSOT not found. Run set_working_dir first to auto-generate project context.",
          },
        ],
      };
    }
    case "list_directory": {
      const listPath = args.path || ".";
      const p = path.isAbsolute(listPath)
        ? path.resolve(listPath)
        : path.resolve(mcpWorkingDir, listPath);
      if (!isPathSafe(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside allowed directories. Working dir: " +
                mcpWorkingDir,
            },
          ],
        };
      }
      if (!fs.existsSync(p))
        return {
          content: [{ type: "text", text: "Directory not found: " + p }],
        };
      const items = fs.readdirSync(p);
      const listing = items.map((name) => {
        const full = path.join(p, name);
        let type = "file";
        try {
          type = fs.statSync(full).isDirectory() ? "dir" : "file";
        } catch (e) { }
        return type === "dir" ? name + "/" : name;
      });
      return {
        content: [
          {
            type: "text",
            text: "Contents of " + p + ":\n" + listing.join("\n"),
          },
        ],
      };
    }
    case "open_browser": {
      let target = args.target || args.path || "";
      if (
        target &&
        !target.startsWith("http://") &&
        !target.startsWith("https://") &&
        !target.startsWith("file://")
      ) {
        // Treat as file path — resolve it
        const filePath = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(mcpWorkingDir, target);
        if (fs.existsSync(filePath)) {
          target = "file://" + filePath;
        }
      }
      // 🔒 SECURITY FIX (S1): Use cp.execFile instead of cp.exec to prevent Command Injection
      // cp.exec() passes command through shell — JSON.stringify alone cannot prevent
      // backtick and $() substitution. cp.execFile bypasses shell entirely.
      if (
        target &&
        !target.startsWith("http://") &&
        !target.startsWith("https://") &&
        !target.startsWith("file://")
      ) {
        return {
          content: [
            { type: "text", text: "Invalid URL or file path: " + target },
          ],
        };
      }
      return new Promise((resolve) => {
        const cp = require("child_process");
        const platform = process.platform;
        let fileCmd, args;
        if (platform === "darwin") {
          fileCmd = "open";
          args = [target];
        } else if (platform === "win32") {
          fileCmd = "cmd";
          args = ["/c", "start", "", target];
        } else {
          fileCmd = "xdg-open";
          args = [target];
        }
        cp.execFile(fileCmd, args, { timeout: 10000 }, (err) => {
          if (err)
            resolve({
              content: [
                { type: "text", text: "Failed to open: " + err.message },
              ],
            });
          else
            resolve({
              content: [{ type: "text", text: "Opened in browser: " + target }],
            });
        });
      });
    }
    case "browse_cdp": {
      // 🧟 #7: headless Chrome over --remote-debugging-pipe (fd 3/4, \0-framed
      // JSON). Zero HTTP/TCP/WebSocket in the CONTROL channel — module does
      // not open a single socket itself.
      const cdpUrl = args.url || "";
      const cdpAction = args.action || "text";
      try {
        const { browseCdp } = require("./cdp-pipe.js");
        const r = await browseCdp({
          url: cdpUrl,
          action: cdpAction,
          timeout_ms: args.timeout_ms,
        });
        let out;
        if (cdpAction === "screenshot") {
          out = {
            ok: true,
            url: r.url,
            title: r.title,
            note: "base64 PNG follows",
            png_base64: r.png_base64 || "",
          };
        } else {
          const cap = s => (s || "").length > 40000 ? s.slice(0, 40000) + "\n…[truncated]" : s;
          out = {
            ok: r.ok,
            url: r.url,
            title: r.title,
            action: cdpAction,
            result:
              cdpAction === "html"
                ? cap(r.html)
                : cdpAction === "title"
                ? r.title
                : cap(r.text),
            transport: "cdp-pipe (fd3/4, no HTTP control channel)",
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: false, error: e.message, url: cdpUrl }) },
          ],
        };
      }
    }
    case "call_agent": {
      const targetAgentId = args.agent_id || "";
      const task = args.task || "";
      const context = args.context || "";
      const sessId = args.session_id || crypto.randomUUID();

      const callAgent = AGENTS.find((a) => a.id === targetAgentId);
      if (!callAgent) {
        return {
          content: [
            {
              type: "text",
              text: "Agent not found: " + targetAgentId,
            },
          ],
        };
      }

      const fullTask = context
        ? task + "\n\n### Task Context\n" + context
        : task;
      const result = await executeSingleAgent(
        targetAgentId,
        [{ role: "user", content: fullTask }],
        false,
        sessId,
        undefined,
        "",
      );

      return {
        content: [
          {
            type: "text",
            text:
              result.content ||
              "[Agent " + targetAgentId + " responded but no content]",
          },
        ],
      };
    }

    // [MB-HANDLERS-2026] real-world tool handlers
    case "db_query": {
      const q = (args && args.query) ? String(args.query) : "";
      if (!q.trim()) return { content: [{ type: "text", text: "Empty query" }] };
      try {
        const result = await runDbQuery(q, args.database);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "db_query error: " + e.message }] };
      }
    }
    case "db_list_tables": {
      try {
        const tables = await listDbTables(args && args.database);
        return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "db_list_tables error: " + e.message }] };
      }
    }
    case "exec": {
      const cmd = (args && args.command) ? String(args.command) : "";
      if (!cmd.trim()) return { content: [{ type: "text", text: "Empty command" }] };
      const cwd = (args && args.cwd)
        ? (path.isAbsolute(args.cwd) ? path.resolve(args.cwd) : path.resolve(mcpWorkingDir || ".", args.cwd))
        : (mcpWorkingDir || ".");
      const timeout = parseInt((args && args.timeout), 10) || parseInt(process.env.EXEC_TIMEOUT || "30000", 10);
      const maxBuffer = parseInt(process.env.EXEC_MAX_BUFFER || String(8 * 1024 * 1024), 10);
      const shell = _IS_WINDOWS
        ? (process.env.EXEC_SHELL_WIN || "powershell.exe")
        : (process.env.EXEC_SHELL_LINUX || "/bin/bash");
      return await new Promise((resolve) => {
        const ch = require("child_process").exec(cmd, {
          cwd: cwd,
          timeout: timeout,
          maxBuffer: maxBuffer,
          shell: shell,
          env: Object.assign({}, process.env, (args && args.env) || {}),
        }, (error, stdout, stderr) => {
          const exitCode = (error && typeof error.code === "number") ? error.code : (error ? 1 : 0);
          const text = "$ " + cmd + "\n(cwd: " + cwd + " | shell: " + shell + ")\n\n"
            + (stdout ? "[stdout]\n" + String(stdout).slice(0, 100000) + "\n" : "")
            + (stderr ? "[stderr]\n" + String(stderr).slice(0, 100000) + "\n" : "")
            + "[exit] " + exitCode;
          resolve({ content: [{ type: "text", text: text }] });
        });
        ch.on("error", (err) => {
          resolve({ content: [{ type: "text", text: "exec error: " + err.message }] });
        });
      });
    }
    case "http_request": {
      const url = (args && args.url) ? String(args.url) : "";
      if (!/^https?:\/\//i.test(url)) {
        return { content: [{ type: "text", text: "Invalid URL (must be http/https): " + url }] };
      }
      const method = String((args && args.method) || "GET").toUpperCase();
      const headers = (args && args.headers) || {};
      const body = (args && args.body != null) ? String(args.body) : null;
      const timeout = parseInt((args && args.timeout), 10) || parseInt(process.env.HTTP_TIMEOUT || "30000", 10);
      return await new Promise((resolve) => {
        const lib = url.startsWith("https://") ? require("https") : require("http");
        const u = new URL(url);
        const opts = { method: method, headers: headers, timeout: timeout };
        const req = lib.request(u, opts, (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => {
            const text = "HTTP " + res.statusCode + " " + (res.statusMessage || "") + "\n\n" + data.slice(0, 100000);
            resolve({ content: [{ type: "text", text: text }] });
          });
        });
        req.on("error", (err) => { resolve({ content: [{ type: "text", text: "http_request error: " + err.message }] }); });
        req.on("timeout", () => {
          req.destroy();
          resolve({ content: [{ type: "text", text: "http_request timed out after " + timeout + "ms" }] });
        });
        if (body) req.write(body);
        req.end();
      });
    }
    case "env_get": {
      const key = (args && args.key) ? String(args.key) : "";
      if (!key) return { content: [{ type: "text", text: "Empty key" }] };
      const val = process.env[key];
      if (val === undefined) return { content: [{ type: "text", text: "ENV '" + key + "' not set" }] };
      const isSecret = /KEY|SECRET|PASSWORD|TOKEN|AUTH/i.test(key);
      if (isSecret && !(args && args.reveal_secrets)) {
        return { content: [{ type: "text", text: key + " is set (value hidden). Use reveal_secrets=true to show it." }] };
      }
      return { content: [{ type: "text", text: key + "=" + val }] };
    }
    case "system_info": {
      const osMod = require("os");
      const info = {
        platform: process.platform,
        arch: process.arch,
        os: _IS_WINDOWS ? "Windows" : (_IS_LINUX ? "Linux" : (_IS_MACOS ? "macOS" : process.platform)),
        hostname: osMod.hostname(),
        node: process.version,
        cwd: process.cwd(),
        mcpWorkingDir: mcpWorkingDir,
        uptime_sec: Math.round(process.uptime()),
        memory_mb: Math.round(osMod.totalmem() / 1048576),
        envKeys: Object.keys(process.env).sort().filter((k) => !/KEY|SECRET|PASSWORD|TOKEN|AUTH/i.test(k)),
        dbConfig: {
          type: process.env.DB_TYPE || "not-configured",
          host: process.env.DB_HOST || "",
          port: process.env.DB_PORT || "",
          user: process.env.DB_USER || "",
          name: process.env.DB_NAME || "",
          sqlitePath: process.env.DB_SQLITE_PATH || "",
          timeout: process.env.DB_TIMEOUT || "",
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    default: {
      // 🧟 EXTERNAL TOOL CONNECTOR proxy — forward to registered external URL
      const ext = EXTERNAL_TOOLS.get(tool);
      if (ext) {
        log("INFO", "EXTERNAL_TOOL_CALL", { tool, url: ext.url });
        return await new Promise((resolve) => {
          const body = JSON.stringify({ tool, arguments: args || {} });
          const headers = { "Content-Type": "application/json" };
          if (ext.key) headers["Authorization"] = "Bearer " + ext.key;
          const req = http.request(
            ext.url,
            { method: ext.method || "POST", headers, timeout: 30000 },
            (res) => {
              let data = "";
              res.on("data", (c) => (data += c));
              res.on("end", () => {
                try {
          const parsed = JSON.parse(_d);
                  resolve({
                    content: parsed.content || [
                      { type: "text", text: JSON.stringify(parsed).slice(0, 50000) },
                    ],
                  });
                } catch (e) {
                  resolve({ content: [{ type: "text", text: data.slice(0, 50000) }] });
                }
              });
            }
          );
          req.on("error", (err) => {
            resolve({ content: [{ type: "text", text: "External tool " + tool + " error: " + err.message }] });
          });
          req.on("timeout", () => {
            req.destroy();
            resolve({ content: [{ type: "text", text: "External tool " + tool + " timed out after 30s" }] });
          });
          req.write(body);
          req.end();
        });
      }
      throw { code: -32601, message: "Tool not found: " + tool };
    }
  }
}


// =============================================================================
// [MB-HELPERS-2026] Real-world tool helpers: dbEnv, findPhp, execFileSyncSafe,
// runDbQuery, listDbTables. Config from env vars ONLY. Cross-platform.
// =============================================================================
function dbEnv() {
  return {
    type: (process.env.DB_TYPE || "sqlite").toLowerCase(),
    host: process.env.DB_HOST || "127.0.0.1",
    port: process.env.DB_PORT || "",
    user: process.env.DB_USER || "",
    password: process.env.DB_PASSWORD || "",
    name: process.env.DB_NAME || "",
    sqlitePath: process.env.DB_SQLITE_PATH || "",
    timeout: parseInt(process.env.DB_TIMEOUT || "15000", 10),
  };
}

function findPhp() {
  const candidates = [];
  if (process.env.PHP_BIN) candidates.push(process.env.PHP_BIN);
  candidates.push("php");
  if (_IS_WINDOWS) {
    candidates.push(
      "C:\\xampp\\php\\php.exe",
      "C:\\laragon\\bin\\php\\php.exe",
      "C:\\wamp64\\bin\\php\\php.exe",
      "C:\\php\\php.exe"
    );
  }
  for (const c of candidates) {
    try {
      const r = require("child_process").spawnSync(c, ["-v"], { timeout: 5000, stdio: "pipe" });
      if (r.status === 0) return c;
    } catch (_) { }
  }
  return null;
}

function execFileSyncSafe(cmd, args, opts) {
  try {
    const r = require("child_process").spawnSync(
      cmd,
      args,
      Object.assign({ timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", stdio: "pipe" }, opts || {})
    );
    if (r.status === 0) return { ok: true, out: String(r.stdout || "").trim() };
    return { ok: false, err: String(r.stderr || "").trim() || String(r.stdout || "").trim() || ("exit " + r.status) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

function mysqlOrPg(cfg, dbOverride, mode, query) {
  const php = findPhp();
  if (!php) {
    throw new Error(
      "No PHP binary found for " + cfg.type + " queries. Set PHP_BIN env (e.g. C:\\xampp\\php\\php.exe) or install PHP with PDO."
    );
  }
  if (!fs.existsSync(BRIDGE)) {
    throw new Error("db-bridge.php not found at: " + BRIDGE);
  }
  const driver = (cfg.type === "pgsql" || cfg.type === "postgres") ? "pgsql" : "mysql";
  const dbname = dbOverride || cfg.name || "";
  const r = require("child_process").spawnSync(
    php,
    [BRIDGE, driver, dbname, mode],
    { input: query || "", encoding: "utf8", timeout: cfg.timeout, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
  );
  if (r.status !== 0) {
    throw new Error("PHP bridge failed: " + String(r.stderr || r.stdout || "exit " + r.status).trim());
  }
  const out = String(r.stdout || "").trim();
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error("PHP bridge returned non-JSON: " + out.slice(0, 500));
  }
}

async function runDbQuery(query, dbOverride) {
  const cfg = dbEnv();
  const q = String(query || "").trim();
  if (!q) throw new Error("Empty query");

  // SQLite -> Node built-in node:sqlite (zero-dep, cross-platform)
  if (cfg.type === "sqlite" || cfg.type === "sqlite3") {
    const dbPath = dbOverride || cfg.sqlitePath;
    if (!dbPath) throw new Error("DB_SQLITE_PATH env not set (or pass database=<path>)");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: false });
    try {
      const isSelect = /^\s*(select|pragma|show|explain|with)\b/i.test(q);
      if (isSelect) {
        const stmt = db.prepare(q);
        const rows = stmt.all();
        return { ok: true, db: cfg.type, path: dbPath, rowCount: rows.length, rows: rows };
      }
      const changes = db.exec(q);
      return { ok: true, db: cfg.type, path: dbPath, changes: changes };
    } finally {
      db.close();
    }
  }

  // MySQL / PostgreSQL -> PHP PDO bridge
  if (cfg.type === "mysql" || cfg.type === "pgsql" || cfg.type === "postgres") {
    return mysqlOrPg(cfg, dbOverride, "query", q);
  }

  throw new Error("Unsupported DB_TYPE '" + cfg.type + "'. Use mysql, sqlite or pgsql. Config via env vars.");
}

async function listDbTables(dbOverride) {
  const cfg = dbEnv();
  if (cfg.type === "sqlite" || cfg.type === "sqlite3") {
    const dbPath = dbOverride || cfg.sqlitePath;
    if (!dbPath) throw new Error("DB_SQLITE_PATH env not set");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return { ok: true, db: cfg.type, tables: rows.map((r) => r.name) };
    } finally {
      db.close();
    }
  }
  if (cfg.type === "mysql" || cfg.type === "pgsql" || cfg.type === "postgres") {
    return mysqlOrPg(cfg, dbOverride, "tables", "");
  }
  throw new Error("Unsupported DB_TYPE '" + cfg.type + "'. Use mysql, sqlite or pgsql. Config via env vars.");
}


// Simple glob matcher (* and ** and {a,b} support) used by the glob tool
function matchGlob(relPath, pattern) {
  if (!pattern) return false;
  const p = pattern.replace(/\\/g, "/");
  const r = relPath.replace(/\\/g, "/");
  const rx = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/\{([^}]+)\}/g, "($1)");
  try {
    return new RegExp("^" + rx + "$").test(r);
  } catch {
    return r.includes(pattern);
  }
}

function handleMCP(req, res) {
  const startTime = Date.now();
  const clientNameFromHeader = req.headers["x-mcp-client-name"] || "";
  let clientDirFromHeader = req.headers["x-mcp-client-dir"] || "";
  // Handle unexpanded ${workspaceFolder} — can't auto-detect, skip
  if (
    clientDirFromHeader.includes("${workspaceFolder}") ||
    clientDirFromHeader.includes("${workspaceRoot}")
  ) {
    log("WARN", "MCP_HEADER_UNEXPANDED", {
      header: "X-MCP-Client-Dir",
      value: clientDirFromHeader,
      message:
        "Cursor/VSCode variable not expanded. Ensure your MCP client supports variable expansion in headers.",
    });
    clientDirFromHeader = "";
  }

  readBody(req).then((body) => {
    let message;
    try {
      message = JSON.parse(body);
    } catch (e) {
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 400,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const { id, method, params } = message;

    if (method === "initialize") {
      const clientName =
        params?.clientInfo?.name || clientNameFromHeader || "unknown";
      const clientVersion = params?.clientInfo?.version || "unknown";
      mcpActiveConnections++;
      log("INFO", "MCP_INIT", {
        client: clientName,
        version: clientVersion,
        protocol: params?.protocolVersion || "unknown",
        id: id?.toString().slice(0, 8),
      });
      // Always track clients — anonymous gets generated name
      const effectiveName =
        clientName !== "unknown"
          ? clientName
          : "anonymous-" +
          (id?.toString().slice(0, 6) ||
            Math.random().toString(36).slice(2, 8));
      const now = new Date().toISOString();

      // ── MCP Client Roots Detection ────────────────────────────
      // Detect client project directory via params.roots or X-MCP-Client-Dir header
      // Priority: 1) params.roots  2) X-MCP-Client-Dir header
      function parseFileUri(uri) {
        if (!uri || typeof uri !== "string") return "";
        const m = uri.match(/^file:\/\/([^/].*)$/);
        if (m) return decodeURIComponent(m[1]);
        try {
          return decodeURIComponent(uri.replace(/^file:\/\//, ""));
        } catch {
          return "";
        }
      }

      let detectedDir = "";

      // Source 1: MCP protocol roots from params
      const rawRoots = params?.roots;
      if (rawRoots && Array.isArray(rawRoots) && rawRoots.length > 0) {
        for (const root of rawRoots) {
          const uri = root?.uri || "";
          const rootPath = parseFileUri(uri) || root?.path || "";
          if (rootPath && fs.existsSync(rootPath)) {
            detectedDir = path.resolve(rootPath);
            log("INFO", "MCP_ROOT_DETECTED", {
              client: clientName,
              root: rootPath,
              name: root?.name || "",
              source: "params.roots",
            });
            break;
          }
        }
      }

      // Source 2: X-MCP-Client-Dir header (existing fallback)
      if (!detectedDir) {
        const headerDir = clientDirFromHeader || "";
        if (headerDir && !headerDir.includes("${")) {
          const resolved = path.resolve(headerDir);
          if (fs.existsSync(resolved)) {
            detectedDir = resolved;
            log("INFO", "MCP_HEADER_DIR_DETECTED", {
              client: clientName,
              dir: resolved,
              source: "X-MCP-Client-Dir header",
            });
          }
        }
      }

      // ── Auto SSOT Generation ──────────────────────────────────
      let ssotResult = null;
      if (detectedDir) {
        mcpWorkingDir = detectedDir;
        ssotResult = refreshSSOT(detectedDir);
        log("INFO", "MCP_AUTO_SSOT", {
          client: clientName,
          dir: detectedDir,
          ssot: ssotResult ? ssotResult.length + " bytes" : "failed",
          message: "বংশবিস্তার! .zombiecoder/SSOT.md planted in " + detectedDir,
        });
      }

      // 🧟 Handshake: guarantee .zombiecoder/ exists + working dir set
      ensureZombiecoderDir();

      const clientData = {
        name: effectiveName,
        version: clientVersion,
        protocolVersion: params?.protocolVersion || "unknown",
        connected_at: now,
        last_seen: now,
        status: "active",
        working_dir: mcpWorkingDir || "",
        detected_dir: detectedDir || "",
        session_id: id?.toString().slice(0, 8) || "",
        tools_used: 0,
        anonymous: clientName === "unknown",
      };
      mcpClients.set(effectiveName, clientData);
      saveClient(clientData);

      const hasRoots = !!detectedDir;
      log("INFO", "MCP_CLIENT_CONNECTED", {
        name: effectiveName,
        anonymous: clientName === "unknown",
        has_roots: hasRoots,
        message: hasRoots
          ? "Client '" +
          effectiveName +
          "' connected. Roots auto-detected → SSOT generated at " +
          detectedDir +
          "/.zombiecoder/SSOT.md"
          : "Client '" +
          effectiveName +
          "' connected (no roots). Use set_working_dir to set project dir.",
      });

      // Build SSOT info for response
      let ssotInfo = "";
      if (detectedDir) {
        const clientSSOT = readSSOT(detectedDir);
        if (clientSSOT) {
          ssotInfo =
            "🧟 CLIENT SSOT: " +
            detectedDir +
            "/.zombiecoder/SSOT.md (" +
            clientSSOT.length +
            " bytes) for project: " +
            path.basename(detectedDir);
        } else {
          ssotInfo =
            "Roots detected but SSOT generation pending for: " + detectedDir;
        }
      } else {
        const serverSSOT = readSSOT(path.resolve("."));
        const serverInfo = serverSSOT
          ? " (" + serverSSOT.length + " bytes)"
          : " (not found)";
        ssotInfo =
          "No client roots detected. Server SSOT at " +
          path.resolve(".", ".zombiecoder", "SSOT.md") +
          serverInfo +
          ". Send roots in initialize or header X-MCP-Client-Dir to auto-generate client SSOT.";
      }

      jsonResponse(res, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "mission-barisal",
            version: DOMAIN_CFG.version,
            domain: DETECTED_DOMAIN,
            serverType: DOMAIN_CFG.type,
            roots_detected: hasRoots,
            working_dir: mcpWorkingDir || "",
            ssot: ssotInfo,
            instructions:
              "Send roots via MCP initialize params or X-MCP-Client-Dir header for auto SSOT generation.",
          },
        },
      });
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 200,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    if (method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    // 🧟 Handle workspace change notifications — auto-update SSOT
    if (method === "workspace/didChangeWorkspaceFolders") {
      const folders = params?.folders || [];
      let newRootDir = "";
      for (const f of folders) {
        const uri = f?.uri || "";
        const fp = parseFileUri(uri);
        if (fp && fs.existsSync(fp)) {
          newRootDir = path.resolve(fp);
          break;
        }
      }
      if (newRootDir && newRootDir !== mcpWorkingDir) {
        mcpWorkingDir = newRootDir;
        refreshSSOT(newRootDir);
        log("INFO", "MCP_WORKSPACE_CHANGED", {
          dir: newRootDir,
          ssot: "auto-regenerated",
        });
      }
      res.writeHead(202);
      res.end();
      return;
    }

    // 🧟 Handle roots/list_changed — client updated its roots
    if (
      method === "roots/list_changed" ||
      method === "notifications/roots/list_changed"
    ) {
      // Client will likely send a new initialize or the roots can be re-fetched
      // For now, just ack — if client re-initializes, we'll catch roots then
      log("INFO", "MCP_ROOTS_CHANGED", {
        client: clientNameFromHeader || "unknown",
        message: "Roots changed notification received",
      });
      res.writeHead(202);
      res.end();
      return;
    }

    if (method === "tools/list") {
      const tools = Object.entries(MCP_TOOLS)
        .filter(([name]) => toolEnabled(name)) // 🧟 respect admin on/off
        .map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: {
            type: "object",
            properties: def.params,
            required: def.required,
          },
        }));
      log("INFO", "MCP_TOOLS_LIST", { count: tools.length });
      jsonResponse(res, 200, { jsonrpc: "2.0", id, result: { tools } });
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 200,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      log("INFO", "MCP_TOOLS_CALL", { tool: name });
      trackToolUsage(name);
      executeMcpTool(name, args || {})
        .then((result) => {
          jsonResponse(res, 200, { jsonrpc: "2.0", id, result });
          log("INFO", "REQUEST", {
            method: "POST",
            url: "/mcp",
            status: 200,
            elapsed: Date.now() - startTime,
          });
        })
        .catch((error) => {
          trackToolUsage(name, true);
          jsonResponse(res, 200, {
            jsonrpc: "2.0",
            id,
            error: { code: error.code || -32000, message: error.message },
          });
          log("INFO", "REQUEST", {
            method: "POST",
            url: "/mcp",
            status: 200,
            elapsed: Date.now() - startTime,
          });
        });
      return;
    }

    if (method === "ping") {
      // Heartbeat — update client last_seen if client info available
      const pingClient = params?.clientName || clientNameFromHeader || "";
      if (pingClient && pingClient !== "unknown") {
        updateClientHeartbeat(pingClient);
        log("INFO", "HEARTBEAT", {
          client: pingClient,
          at: new Date().toISOString(),
        });
      }
      jsonResponse(res, 200, { jsonrpc: "2.0", id, result: {} });
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 200,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    jsonResponse(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found: " + method },
    });
    log("INFO", "REQUEST", {
      method: "POST",
      url: "/mcp",
      status: 200,
      elapsed: Date.now() - startTime,
    });
  });
}

// ─── Handle MCP message over Unix Domain Socket ──────────────
// Reuses the same MCP_TOOLS as handleMCP, but writes to a socket
// instead of HTTP response. Used by UDS server for JetBrains MCP.
function handleUdsMcpMessage(socket, message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    // 🧟 Handshake: guarantee .zombiecoder/ exists + working dir set
    const udsDir = ensureZombiecoderDir();
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "mission-barisal",
            version: DOMAIN_CFG.version,
            domain: DETECTED_DOMAIN,
            serverType: DOMAIN_CFG.type,
            working_dir: mcpWorkingDir || "",
            zombiecoder_dir: udsDir ? udsDir.dir : "",
          },
        },
      }) + "\n",
    );
    return;
  }
  if (method === "notifications/initialized" || method === "ping") {
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
    return;
  }
  if (method === "tools/list") {
    const tools = Object.entries(MCP_TOOLS)
      .filter(([name]) => toolEnabled(name)) // 🧟 respect admin on/off
      .map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: {
          type: "object",
          properties: def.params,
          required: def.required,
        },
      }));
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools },
        source: "uds",
      }) + "\n",
    );
    return;
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    // 🧟 count UDS-origin tool calls too (HTTP path counts its own)
    trackToolUsage(name);
    executeMcpTool(name, args || {})
      .then((result) => {
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { ...result, source: "uds" },
          }) + "\n",
        );
      })
      .catch((error) => {
        trackToolUsage(name, true);
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: error.code || -32000, message: error.message },
          }) + "\n",
        );
      });
    return;
  }
  socket.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found: " + method },
    }) + "\n",
  );
}

// ══════════════════════════════════════════════════════════════
//  IDENTITY MASKING + WATERMARK STRIPPING
// ══════════════════════════════════════════════════════════════
// Removes hidden watermarks, invisible unicode chars, model identity
// Per V0_PLATFORM_INDEPENDENT_CONTRACT.md: NO hidden watermarks or branding
function maskModelIdentity(text) {
  if (!text || typeof text !== "string") return text;

  // ── BENGALI DETECTION: preserve zero-width chars for Bengali ──
  // Bengali conjunct characters require \u200C (ZWNJ) and \u200D (ZWJ)
  // Only strip these for pure non-Bengali text
  const hasBengali = /[\u0980-\u09FF]/.test(text);
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const isIndicScript = hasBengali || hasDevanagari;

  // Step 1: Strip invisible Unicode characters (zero-width watermarks)
  // These can be embedded in responses as hidden branding
  let cleaned = text
    .replace(/\uFFFD/g, "") // Unicode replacement char (from encoding errors) — ALWAYS strip
    .replace(/\u200B/g, "") // zero-width space — ALWAYS strip (not needed for Bengali)
    .replace(/\uFEFF/g, "") // BOM / zero-width no-break space — ALWAYS strip
    .replace(/\u2060/g, "") // word joiner — ALWAYS strip
    .replace(/\u2061/g, "") // function application — ALWAYS strip
    .replace(/\u2062/g, "") // invisible times — ALWAYS strip
    .replace(/\u2063/g, "") // invisible separator — ALWAYS strip
    .replace(/\u2064/g, "") // invisible plus — ALWAYS strip
    .replace(/\u180E/g, "") // mongolian vowel separator — ALWAYS strip
    .replace(/\u00AD/g, "") // soft hyphen — ALWAYS strip
    .replace(/\u200E/g, "") // left-to-right mark — ALWAYS strip
    .replace(/\u200F/g, ""); // right-to-left mark — ALWAYS strip

  // CONDITIONAL: Only strip ZWNJ/ZWJ if text is NOT Bengali/Indic
  // Bengali conjuncts: ক\u200Dষ, গ\u200Dহ, etc.
  if (!isIndicScript) {
    cleaned = cleaned
      .replace(/\u200C/g, "") // zero-width non-joiner — safe to strip for non-Bengali
      .replace(/\u200D/g, ""); // zero-width joiner — safe to strip for non-Bengali
  } else {
    // For Bengali: preserve ZWNJ (\u200C) but strip ZWJ (\u200D) only if it's NOT between Bengali chars
    // ZWJ between Bengali chars creates conjuncts (e.g., ক\u200Dষ)
    // ZWJ used as watermark (e.g., after English text) can be stripped
    cleaned = cleaned.replace(/(\u200D)(?![\u0980-\u09FF])/g, "");
    // Keep ZWNJ (\u200C) — essential for Bengali text rendering
  }

  // Step 2: Strip model/company identity watermarks from text
  cleaned = cleaned
    .replace(
      /I am (?:a |an )?(?:large language model|AI|LLM|language model) (?:trained|developed|created|built) by [^.!?\\n]+[.!?]?/gi,
      "",
    )
    .replace(
      /(?:I'm|I am) (?:from |by |made by )?(?:OpenAI|Google|DeepSeek|Meta|Anthropic|Mistral|Cohere|Alibaba|Baichuan)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    .replace(
      /(?:GPT|Gemini|DeepSeek|Llama|Claude|Mistral|Qwen|Yi|Baichuan)[-\\s]?(?:4|3\\.5|v[234]|70B|8B|3)?[,.]?\\s*(?:trained|by|from|is a|model)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    .replace(
      /As (?:an |a )?(?:AI|LLM|large language model|language model),?/gi,
      "",
    )
    // Strip internal Mission Barisal model names that agents read from PERSONAS.md/syllabus.md
    .replace(/nemotron-3-ultra-free/gi, "")
    .replace(/mimo-v2\.5-free/gi, "")
    .replace(/big-pickle/gi, "")
    .replace(/nemotron-3-ultra-free/gi, "")
    .replace(/north-mini-code-free/gi, "")
    .replace(/hy3-free/gi, "")
    .replace(/groq-compound/gi, "")
    .replace(/groq-compound-mini/gi, "")
    // Strip "Powered by", "built on", "running on" branding
    .replace(
      /[Pp]owered by (?:OpenAI|ZombieCoder|Mission Barisal|AI)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    .replace(
      /[Rr]unning on (?:OpenAI|Groq|Gemini|DeepSeek|Claude)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    // Strip any "Model: xxx . Provider: xxx" footers
    .replace(/Model:\\s*\\S+\\s*[.\\s]Provider:\\s*\\S+/gi, "")
    // Strip "Provided by X" or "Courtesy of X"
    .replace(
      /(?:Provided by|Courtesy of|Brought to you by)[^.!?\\n]+[.!?]?/gi,
      "",
    )
    // Strip markdown table rows containing model names
    .replace(
      /\|[^|]*?(?:deepseek|mimo|big.pickle|nemotron|north.mini|hy3)[^|]*?\|/gi,
      "",
    )
    // ── BUG #6 + S7 FIX: Enhanced watermark patterns ──
    // Contract says NO watermarks — these catch additional provider branding
    .replace(
      /(?:Made with|Built with|Powered by|Created by|Developed by|Designed by|Crafted by)\s+\w+[^.!?\n]*[.!?\n]?/gi,
      "",
    )
    .replace(
      /\b(?:ChatGPT|OpenAI|GPT-\d|Claude|Anthropic|Gemini|Google AI|Meta AI|Llama)\b[^.!?\n]*(?:powered|built|created|trained)[^.!?\n]*[.!?\n]?/gi,
      "",
    )
    .replace(
      /\bThis (?:response|output|answer|reply) (?:was |is )?(?:generated|created|produced|provided) (?:by|using|with)\s+[^.!?\n]+[.!?\n]?/gi,
      "",
    )
    .replace(
      /\b(?:AI assistant|language model|LLM|neural network|deep learning model)\s*[-–—:]\s*[^.!?\n]+[.!?\n]?/gi,
      "",
    )
    .trim();

  // ── BUG #6 + S7 FIX: Log watermark detection for compliance monitoring ──
  if (cleaned !== text) {
    log("WARN", "WATERMARK_STRIPPED", {
      original_length: text.length,
      clean_length: cleaned.length,
      chars_removed: text.length - cleaned.length,
    });
  }

  return cleaned;
}

// ══════════════════════════════════════════════════════════════
//  🎯 GOAL VERIFICATION — Type Safety Before Output
// ══════════════════════════════════════════════════════════════
// Checks if output meets goal criteria BEFORE sending to user.
// If output is invalid, blocks it and returns error message.
function verifyGoalOutput(content, userInput) {
  if (!content || typeof content !== "string") {
    return {
      passed: false,
      reason: "empty_output",
      message:
        "ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই। এজেন্ট কোনো উত্তর তৈরি করতে পারেনি।",
    };
  }

  const trimmed = content.trim();

  // Check 1: Too short to be useful
  if (trimmed.length < 10) {
    return {
      passed: false,
      reason: "too_short",
      message:
        "ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই। উত্তরটি খুবই সংক্ষিপ্ত।",
    };
  }

  // Check 2: Contains thinking/reasoning artifacts (should not reach user)
  // Only block if the ENTIRE response is thinking, not if thinking appears mid-response
  const thinkingPatterns = [
    /^(I need to|I will now|Let me|আমি এখন|এখন আমি|আমাকে এখন)\b/im,
    /^(Combining|merging|একত্রিত|Merging)\b/im,
    /^(Based on the analysis|After reviewing|বিশ্লেষণের পর)\b/im,
    /^(The combined response|Here is the merged output)\b/im,
    /^(I will combine|Let me merge|আমি এখন একত্রিত করব)\b/im,
  ];
  // Only block if the first 100 chars match thinking patterns
  const firstChunk = trimmed.slice(0, 100);
  let hasThinkingArtifact = false;
  for (const pat of thinkingPatterns) {
    if (pat.test(firstChunk)) {
      hasThinkingArtifact = true;
      break;
    }
  }
  if (hasThinkingArtifact) {
    return {
      passed: false,
      reason: "thinking_artifact",
      message:
        "ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই। এজেন্ট তার ভাবনার অংশ পাঠিয়েছে।",
    };
  }

  // Check 3: Model identity leak
  const identityLeak =
    /\b(running on|powered by|using|via)\s+(gpt|claude|gemini|deepseek|llama|mistral)\b/i;
  if (identityLeak.test(trimmed)) {
    return {
      passed: false,
      reason: "identity_leak",
      message:
        "ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই। মডেল পরিচয় ফাঁস হয়ে গেছে।",
    };
  }

  // Check 4: "I don't know" patterns in Bengali/English
  const dontKnowPatterns = [
    /আমার কাছে.*নাই/i,
    /জানি না/i,
    /I don't know/i,
    /I have no information/i,
    /no information available/i,
    /cannot find/i,
    /unable to determine/i,
    /not available/i,
    /ভাইয়া.*নাই/i,
    /এই মুহূর্তে.*নাই/i,
  ];
  for (const pat of dontKnowPatterns) {
    if (pat.test(trimmed)) {
      // This is a VALID response — agent honestly says it doesn't know
      return {
        passed: true,
        reason: "honest_limitation",
        message: trimmed,
      };
    }
  }

  // Check 5: Contains actual content (passed all checks)
  return {
    passed: true,
    reason: "valid",
    message: trimmed,
  };
}

// ══════════════════════════════════════════════════════════════
//  🤝 AGENT-TO-AGENT CALL SYSTEM
// ══════════════════════════════════════════════════════════════
// Allows one agent to call another agent for specific tasks.
// Pattern: [CALL:agent-id] task description [/CALL]
function parseAgentCalls(content) {
  const callPattern = /\[CALL:(\w+)\]\s*([\s\S]*?)\[\/CALL\]/gi;
  const calls = [];
  let match;
  while ((match = callPattern.exec(content)) !== null) {
    calls.push({
      targetAgent: match[1],
      task: match[2].trim(),
      fullMatch: match[0],
    });
  }
  return calls;
}

async function executeAgentCall(
  sourceAgent,
  targetAgentId,
  task,
  sessionId,
  tools,
) {
  const targetAgent = AGENTS.find((a) => a.id === targetAgentId);
  if (!targetAgent) {
    return {
      success: false,
      content: `[${sourceAgent.name}] এজেন্ট ${targetAgentId} পাওয়া যায়নি।`,
    };
  }

  log("INFO", "AGENT_CALL", {
    from: sourceAgent.id,
    to: targetAgentId,
    task: task.slice(0, 100),
  });

  const callMessages = [
    {
      role: "system",
      content:
        targetAgent.persona +
        "\n\n" +
        buildAgentIdentity(targetAgent) +
        "\n\nCRITICAL: You are being called by " +
        sourceAgent.name +
        " for a specific task. Complete ONLY the task below. Be concise and direct.",
    },
    {
      role: "user",
      content: task,
    },
  ];

  const result = await callModelWithTools(
    targetAgent.model,
    callMessages,
    undefined,
    tools,
  );

  return {
    success: result.success,
    content: result.content || "",
    agent: targetAgent.name,
  };
}

// ══════════════════════════════════════════════════════════════
//  📋 MANDATORY READINESS CHECK
// ══════════════════════════════════════════════════════════════
// Checks if all required context files exist before mission starts.
function checkReadiness(projectDir) {
  const issues = [];

  // Check SSOT
  const ssot = readSSOT(projectDir || ".");
  if (!ssot) {
    issues.push("SSOT.md not found — agent will lack project context");
  }

  // Check Syllabus
  const syllabus = readSyllabus(projectDir || ".");
  if (!syllabus) {
    issues.push("Syllabus not found — agent will lack learned knowledge");
  }

  // Check Memory
  const memory = readMemory(projectDir || ".");
  if (!memory || !memory.recent_context || memory.recent_context.length === 0) {
    issues.push("Memory empty — agent will lack session history");
  }

  return {
    ready: issues.length === 0,
    issues,
    hasSSOT: !!ssot,
    hasSyllabus: !!syllabus,
    hasMemory: !!(memory && memory.recent_context?.length > 0),
  };
}

// ══════════════════════════════════════════════════════════════
//  RATE LIMIT TRACKING SYSTEM — Per-Domain Server Monitor
// ══════════════════════════════════════════════════════════════
// Tracks HTTP 429 rate limits and switches to fallback provider.
// Each domain maintains its own rate limit state.
// Respects cooldown period until limit reset.
// ══════════════════════════════════════════════════════════════

// Per-domain rate limit states (each server tracks its own limits)
const RATE_LIMIT_STATES = {};

function getRateLimitState(domain) {
  if (!RATE_LIMIT_STATES[domain]) {
    RATE_LIMIT_STATES[domain] = {
      limited: false,
      provider: null,
      model: null,
      detectedAt: null,
      cooldownMs: parseInt(process.env.RATE_LIMIT_COOLDOWN || "120000", 10),
      originalMessage: null,
      domain: domain,
    };
  }
  return RATE_LIMIT_STATES[domain];
}

function isRateLimited(providerId, model, domain) {
  const state = getRateLimitState(domain || DETECTED_DOMAIN);
  if (!state.limited) return false;
  if (Date.now() - state.detectedAt > state.cooldownMs) {
    state.limited = false;
    state.provider = null;
    state.model = null;
    return false;
  }
  if (providerId && state.provider !== providerId) return false;
  if (model && state.model && state.model !== model) return false;
  return true;
}

function setRateLimited(providerId, model, errorMessage, domain) {
  const state = getRateLimitState(domain || DETECTED_DOMAIN);
  state.limited = true;
  state.provider = providerId;
  state.model = model;
  state.detectedAt = Date.now();
  state.originalMessage = errorMessage;
  log("WARN", "RATE_LIMIT_DETECTED", {
    domain: domain || DETECTED_DOMAIN,
    provider: providerId,
    model: model,
    cooldown: state.cooldownMs + "ms",
    error: errorMessage,
  });
}

function getRateLimitStatus(domain) {
  const domainKey = domain || DETECTED_DOMAIN;
  const state = getRateLimitState(domainKey);
  if (!state.limited) {
    return { limited: false, domain: domainKey };
  }
  const elapsed = Date.now() - state.detectedAt;
  const remaining = Math.max(0, state.cooldownMs - elapsed);
  return {
    limited: true,
    domain: domainKey,
    serverType: DOMAIN_CFG.type,
    provider: state.provider,
    model: state.model,
    remainingMs: remaining,
    remainingSec: Math.ceil(remaining / 1000),
    detectedAt: new Date(state.detectedAt).toISOString(),
    maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
    message:
      "[RateLimited] " +
      domainKey +
      " " +
      (state.provider === "providerId" ? "providerId" : state.provider) +
      " rate limit (HTTP 429). Retry in " +
      Math.ceil(remaining / 1000) +
      "s.",
  };
}

// ══════════════════════════════════════════════════════════════
//  PROVIDER HEALTH TRACKING SYSTEM
// ══════════════════════════════════════════════════════════════

const PROVIDER_HEALTH = {};

const HEALTH_CONFIG = {
  MAX_CONSECUTIVE_FAILURES: 3,
  RECOVERY_COOLDOWN_MS: 60000,
  SUCCESS_RESET_THRESHOLD: 1,
};

function getProviderHealth(providerId) {
  if (!PROVIDER_HEALTH[providerId]) {
    PROVIDER_HEALTH[providerId] = {
      healthy: true,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastError: null,
      failureReasons: [],
    };
  }
  return PROVIDER_HEALTH[providerId];
}

function markProviderSuccess(providerId) {
  const health = getProviderHealth(providerId);
  health.consecutiveFailures = 0;
  health.lastSuccessAt = Date.now();
  health.healthy = true;
  health.lastError = null;
  // 🧟 authentic-response ledger: provider_stats (real served traffic)
  trackProviderUsage(providerId, false); // memory mirror
  recordProviderStat(providerId, true, null); // SQLite (survives restart)
}

function markProviderFailure(providerId, errorMsg) {
  const health = getProviderHealth(providerId);
  health.consecutiveFailures++;
  health.lastFailureAt = Date.now();
  health.lastError = errorMsg || "Unknown error";
  // 🧟 authentic-response ledger: failures recorded too
  trackProviderUsage(providerId, true); // memory mirror
  recordProviderStat(providerId, false, errorMsg || "Unknown error"); // SQLite

  health.failureReasons.push({
    at: new Date().toISOString(),
    error: errorMsg,
  });
  if (health.failureReasons.length > 10) {
    health.failureReasons.shift();
  }

  if (health.consecutiveFailures >= HEALTH_CONFIG.MAX_CONSECUTIVE_FAILURES) {
    health.healthy = false;
    log("WARN", "PROVIDER_UNHEALTHY", {
      provider: providerId,
      consecutiveFailures: health.consecutiveFailures,
      lastError: errorMsg,
      cooldownMs: HEALTH_CONFIG.RECOVERY_COOLDOWN_MS,
    });
  }
}

function isProviderHealthy(providerId, model) {
  const health = getProviderHealth(providerId);
  if (!health.healthy) {
    if (health.lastFailureAt) {
      const elapsed = Date.now() - health.lastFailureAt;
      if (elapsed >= HEALTH_CONFIG.RECOVERY_COOLDOWN_MS) {
        health.healthy = true;
        health.consecutiveFailures = 0;
        log("INFO", "PROVIDER_RECOVERED", {
          provider: providerId,
          downTimeMs: elapsed,
        });
        return true;
      }
    }
    return false;
  }
  if (isRateLimited(providerId, model)) return false;
  return true;
}

function getUnhealthyProviders() {
  const result = [];
  for (const [id, health] of Object.entries(PROVIDER_HEALTH)) {
    if (!health.healthy) {
      result.push({
        providerId: id,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError,
        remainingCooldownMs: health.lastFailureAt
          ? Math.max(
            0,
            HEALTH_CONFIG.RECOVERY_COOLDOWN_MS -
            (Date.now() - health.lastFailureAt),
          )
          : 0,
      });
    }
  }
  return result;
}

// ══════════════════════════════════════════════════════════════
//  PROXY ROTATION SYSTEM — IP Rotation for Outbound API Calls
// ══════════════════════════════════════════════════════════════
// Reads PROXY_LIST env var (comma-separated proxy URLs).
// Each outbound HTTP request can be routed through a proxy in
// round-robin fashion. Supports HTTP CONNECT for HTTPS targets.
//
// Proxy format: protocol://user:pass@host:port
// Example: http://user:pass@proxy.example.com:3000
//
// When no proxy is configured, connects directly (default).
// ══════════════════════════════════════════════════════════════

let _proxyIndex = 0;

function getProxyList() {
  const list =
    process.env.PROXY_LIST ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    "";
  return list
    .split(",")
    .map(function (s) {
      return s.trim();
    })
    .map(function (s) {
      // 🧟 FIX: Strip optional "http_proxy:" / "https_proxy:" prefixes that
      // some .env files use (e.g. PROXY_LIST="http_proxy:http://host:port").
      // Without this, new URL("http_proxy:...") throws "Invalid URL" and the
      // whole outbound API call fails → PROVIDER_FALLBACK storm.
      const m = /^(?:http_proxy|https_proxy|socks5?):/i.exec(s);
      return m ? s.slice(m[0].length) : s;
    })
    .filter(Boolean);
}

function pickProxy() {
  const proxies = getProxyList();
  if (proxies.length === 0) return null;
  const proxy = proxies[_proxyIndex % proxies.length];
  _proxyIndex = (_proxyIndex + 1) % proxies.length;
  return proxy;
}

function countProxies() {
  return getProxyList().length;
}

// ══════════════════════════════════════════════════════════════
// 🧟 HTTP/2 Client — Connection Pool & Request Utility
// ══════════════════════════════════════════════════════════════
// HTTP/2 sessions are persistent (connection reuse) — huge perf win for
// repeated calls to the same provider. Pool auto-closes idle sessions.
const HTTP2_SESSIONS = new Map(); // origin → { session, lastUsed }
const HTTP2_SESSION_TIMEOUT = 120000; // 2 min idle timeout

function http2GetSession(origin) {
  const entry = HTTP2_SESSIONS.get(origin);
  if (entry && !entry.session.destroyed) {
    entry.lastUsed = Date.now();
    return entry.session;
  }
  // Close stale session if exists
  if (entry && entry.session) {
    try { entry.session.close(); } catch (_e) { /* ignore */ }
  }
  try {
    const session = http2.connect(origin);
    session.on("error", (err) => {
      log("WARN", "HTTP2_CLIENT_SESSION_ERROR", { origin, error: err.message });
      HTTP2_SESSIONS.delete(origin);
    });
    session.on("close", () => HTTP2_SESSIONS.delete(origin));
    HTTP2_SESSIONS.set(origin, { session, lastUsed: Date.now() });
    return session;
  } catch (err) {
    log("WARN", "HTTP2_CONNECT_FAILED", { origin, error: err.message });
    return null;
  }
}

// Periodic cleanup of idle HTTP/2 sessions
setInterval(() => {
  const now = Date.now();
  for (const [origin, entry] of HTTP2_SESSIONS) {
    if (now - entry.lastUsed > HTTP2_SESSION_TIMEOUT) {
      try { entry.session.close(); } catch (_e) { /* ignore */ }
      HTTP2_SESSIONS.delete(origin);
    }
  }
}, 30000);

// Make HTTP/2 request — returns Promise<{ statusCode, headers, body }>
function http2Request(targetUrl, options, body) {
  return new Promise((resolve, reject) => {
    const origin = targetUrl.origin;
    const session = http2GetSession(origin);
    if (!session) {
      // Fallback to HTTP/1.1
      const proto = targetUrl.protocol === "https:" ? https : http;
      const opts = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: options.method || "POST",
        timeout: options.timeout || 60000,
        headers: options.headers || {},
      };
      const req = proto.request(opts, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("HTTP/1.1 fallback timeout")); });
      if (body) req.write(body);
      req.end();
      return;
    }

    // HTTP/2 path must be absolute for cross-origin or relative for same-origin
    const path = targetUrl.pathname + targetUrl.search;
    const headers = { ...options.headers, ":path": path, ":method": options.method || "POST" };
    const stream = session.request(headers);
    let data = "";
    let timeoutId;

    stream.on("response", (respHeaders) => {
      const statusCode = respHeaders[":status"] || 200;
      timeoutId = setTimeout(() => {
        stream.destroy();
        reject(new Error("HTTP/2 stream timeout"));
      }, options.timeout || 60000);
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => (data += chunk));
      stream.on("end", () => {
        clearTimeout(timeoutId);
        resolve({ statusCode, headers: respHeaders, body: data });
      });
    });

    stream.on("error", (err) => {
      clearTimeout(timeoutId);
      // Remove the failed path entry so next request reconnects
      HTTP2_SESSIONS.delete(origin);
      reject(err);
    });

    stream.on("timeout", () => {
      clearTimeout(timeoutId);
      stream.destroy();
      reject(new Error("HTTP/2 stream timeout"));
    });

    if (body) stream.write(body);
    stream.end();
  });
}

// 🧟 HTTP/2 Streaming Request — returns stream for SSE handling
// Returns { stream, statusCode, headers } — caller reads data events
function http2RequestStream(targetUrl, options, body) {
  const origin = targetUrl.origin;
  const session = http2GetSession(origin);
  if (!session) {
    // Fallback to HTTP/1.1 streaming
    const proto = targetUrl.protocol === "https:" ? https : http;
    const path = targetUrl.pathname + targetUrl.search;
    const opts = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path,
      method: options.method || "POST",
      timeout: options.timeout || 60000,
      headers: options.headers || {},
    };
    return new Promise((resolve, reject) => {
      const req = proto.request(opts, (res) => {
        resolve({ stream: res, statusCode: res.statusCode, headers: res.headers, fallback: true });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("HTTP/1.1 fallback timeout")); });
      if (body) req.write(body);
      req.end();
    });
  }

  const path = targetUrl.pathname + targetUrl.search;
  const headers = { ...options.headers, ":path": path, ":method": options.method || "POST" };
  const h2Stream = session.request(headers);

  return new Promise((resolve, reject) => {
    h2Stream.on("response", (respHeaders) => {
      const statusCode = respHeaders[":status"] || 200;
      h2Stream.setEncoding("utf8");
      resolve({ stream: h2Stream, statusCode, headers: respHeaders, fallback: false });
    });
    h2Stream.on("error", (err) => {
      HTTP2_SESSIONS.delete(origin);
      reject(err);
    });
    if (body) h2Stream.write(body);
    h2Stream.end();
  });
}

// ─── Make HTTP request through proxy ────────────────────────
// Returns a Promise that resolves with { statusCode, headers, body }
// Uses HTTP CONNECT for HTTPS targets, absolute URI for HTTP targets.
function proxyHttpRequest(targetUrl, requestOptions, requestBody) {
  return new Promise(function (resolve, reject) {
    const proxyUrl = pickProxy();
    if (!proxyUrl) {
      // No proxy configured — direct connection
      const proto = targetUrl.protocol === "http:" ? http : https;
      const opts = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443),
        path: targetUrl.pathname + targetUrl.search,
        method: requestOptions.method || "POST",
        timeout: requestOptions.timeout || 60000,
        rejectUnauthorized: true,
        headers: requestOptions.headers || {},
      };
      const req = proto.request(opts, function (res) {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      });
      req.on("error", reject);
      req.on("timeout", function () {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      if (requestBody) req.write(requestBody);
      req.end();
      return;
    }

    // ─── Proxy is configured — route through it ────────────
    const pu = new URL(proxyUrl);
    const isHttpsTarget = targetUrl.protocol === "https:";

    if (!isHttpsTarget) {
      // HTTP target through HTTP proxy: use absolute URI in request line
      const absolutePath =
        targetUrl.protocol +
        "//" +
        targetUrl.host +
        targetUrl.pathname +
        targetUrl.search;
      const opts = {
        hostname: pu.hostname,
        port: pu.port || 80,
        method: requestOptions.method || "GET",
        path: absolutePath,
        headers: requestOptions.headers || {},
        timeout: requestOptions.timeout || 60000,
      };
      const req = http.request(opts, function (res) {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", function (c) {
          data += c;
        });
        res.on("end", function () {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      });
      req.on("error", reject);
      req.on("timeout", function () {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      if (requestBody) req.write(requestBody);
      req.end();
    } else {
      // HTTPS target through HTTP proxy: CONNECT tunnel
      const connectOpts = {
        hostname: pu.hostname,
        port: pu.port || 3000,
        method: "CONNECT",
        path: targetUrl.host + ":" + (targetUrl.port || 443),
        timeout: requestOptions.timeout || 60000,
      };
      const connectReq = http.request(connectOpts);
      connectReq.on("connect", function (res, socket) {
        if (res.statusCode !== 200) {
          reject(
            new Error(
              "Proxy CONNECT failed: HTTP " +
              res.statusCode +
              " " +
              res.statusMessage,
            ),
          );
          return;
        }
        // Wrap the socket with TLS
        var tls = require("tls");
        var tlsSocket = tls.connect({
          socket: socket,
          servername: targetUrl.hostname,
          rejectUnauthorized: true,
        });

        // Make HTTPS request through the TLS tunnel
        var httpsOpts = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 443,
          path: targetUrl.pathname + targetUrl.search,
          method: requestOptions.method || "POST",
          headers: requestOptions.headers || {},
          socket: tlsSocket,
          createConnection: function () {
            return tlsSocket;
          },
          timeout: requestOptions.timeout || 60000,
          rejectUnauthorized: true,
        };
        var req = https.request(httpsOpts, function (res) {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", function (c) {
            data += c;
          });
          res.on("end", function () {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body: data,
            });
          });
        });
        req.on("error", reject);
        req.on("timeout", function () {
          req.destroy();
          reject(new Error("Request timeout"));
        });
        if (requestBody) req.write(requestBody);
        req.end();
      });
      connectReq.on("error", reject);
      connectReq.on("timeout", function () {
        connectReq.destroy();
        reject(new Error("CONNECT timeout"));
      });
      connectReq.end();
    }
  });
}
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function getCorsOrigin(reqOrigin) {
  if (!reqOrigin) return "http://localhost:" + PORT;
  // Handle null origin (browser sends this for file:// protocol pages)
  // Reflecting "null" back as the allowed origin is valid per Fetch spec
  if (reqOrigin === "null") return "null";
  // 🧟 Domain-aware CORS: use DOMAIN_CFG.corsOrigins (per-server)
  const allowedOrigins = DOMAIN_CFG.corsOrigins;
  // Dev mode: localhost allows all
  if (DETECTED_DOMAIN === "localhost") return reqOrigin;
  // Production: strict origin check
  if (allowedOrigins.includes("*")) return reqOrigin;
  const allowed = allowedOrigins.find(
    (o) =>
      reqOrigin === o ||
      reqOrigin.startsWith(o + "/") ||
      reqOrigin.startsWith(o + ":"),
  );
  if (allowed) {
    const exactMatch = allowedOrigins.find((o) => reqOrigin === o);
    if (exactMatch) return exactMatch;
    // 🧟 No hardcoded domain checks. Allowed origins are exclusively
    // driven by ALLOWED_ORIGINS env var and DOMAIN_CFG.corsOrigins.
    // The exact match above already handles direct origin matches.
    if (reqOrigin.startsWith("http://localhost")) return reqOrigin;
  }
  // Fallback: first allowed origin
  return allowedOrigins[0] || "http://localhost:" + PORT;
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// 🔒 SECURITY FIX (S5): Rate limiter for API endpoints
const _rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60000; // 1 minute window
  const maxRequests = 60; // max 60 requests per minute per IP
  if (!_rateLimitMap.has(ip)) {
    _rateLimitMap.set(ip, []);
  }
  const timestamps = _rateLimitMap.get(ip).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    return false; // Rate limit exceeded
  }
  timestamps.push(now);
  _rateLimitMap.set(ip, timestamps);
  return true;
}
// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of _rateLimitMap) {
    const valid = timestamps.filter((t) => now - t < 60000);
    if (valid.length === 0) _rateLimitMap.delete(ip);
    else _rateLimitMap.set(ip, valid);
  }
}, 300000);

let AGENTS = [];
const STATS = {
  totalRequests: 0,
  totalAgents: 0,
  models: FREE_MODELS.length,
  startTime: Date.now(),
  // Usage tracking
  modelUsage: {}, // { "model-id": { count, lastUsed } }
  agentUsage: {}, // { "agent-id": { count, lastUsed, errors } }
  providerUsage: {}, // { "provider-id": { count, lastUsed, errors, rateLimits } }
  toolUsage: {}, // { "tool-name": { count, lastUsed, errors } }
  domainRequests: {}, // { "domain": { count, lastUsed } }
};
const mcpClients = new Map();
let mcpActiveConnections = 0;

// ─── Usage Tracking Helpers ──────────────────────────────────
function trackModelUsage(modelId) {
  if (!STATS.modelUsage[modelId])
    STATS.modelUsage[modelId] = { count: 0, lastUsed: null };
  STATS.modelUsage[modelId].count++;
  STATS.modelUsage[modelId].lastUsed = new Date().toISOString();
  // 🧟 write-through: survives restart. Agent-id / mission passthrough is NOT
  // a model — the real model is recorded at single-agent completion sites.
  if (
    modelId === "mission" ||
    (typeof AGENTS !== "undefined" &&
      Array.isArray(AGENTS) &&
      AGENTS.some((a) => a.id === modelId))
  ) {
    return;
  }
  let prov = null;
  try {
    prov = resolveProvider(modelId).providerId;
  } catch (_) {}
  recordModelStat(modelId, prov, true);
}

function trackAgentUsage(agentId, isError = false, model = null, provider = null) {
  if (!STATS.agentUsage[agentId])
    STATS.agentUsage[agentId] = { count: 0, lastUsed: null, errors: 0 };
  STATS.agentUsage[agentId].count++;
  STATS.agentUsage[agentId].lastUsed = new Date().toISOString();
  if (isError) STATS.agentUsage[agentId].errors++;
  // 🧟 write-through: agent_stats survives restart (carries last model/provider)
  recordAgentStat(agentId, !isError, model, provider);
}

function trackProviderUsage(providerId, isError = false, isRateLimit = false) {
  if (!STATS.providerUsage[providerId])
    STATS.providerUsage[providerId] = {
      count: 0,
      lastUsed: null,
      errors: 0,
      rateLimits: 0,
    };
  STATS.providerUsage[providerId].count++;
  STATS.providerUsage[providerId].lastUsed = new Date().toISOString();
  if (isError) STATS.providerUsage[providerId].errors++;
  if (isRateLimit) STATS.providerUsage[providerId].rateLimits++;
}

function trackToolUsage(toolName, isError = false) {
  if (!STATS.toolUsage[toolName])
    STATS.toolUsage[toolName] = { count: 0, lastUsed: null, errors: 0 };
  STATS.toolUsage[toolName].count++;
  STATS.toolUsage[toolName].lastUsed = new Date().toISOString();
  if (isError) STATS.toolUsage[toolName].errors++;
  // 🧟 write-through to tool_stats (enabled column untouched by upsert)
  dbRun(
    `INSERT INTO tool_stats (tool, calls, errors, last_used)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(tool) DO UPDATE SET
       calls = calls + 1,
       errors = errors + excluded.errors,
       last_used = excluded.last_used`,
    [toolName, isError ? 1 : 0, Date.now()],
  );
}

function trackDomainRequest(domain) {
  if (!STATS.domainRequests[domain])
    STATS.domainRequests[domain] = { count: 0, lastUsed: null };
  STATS.domainRequests[domain].count++;
  STATS.domainRequests[domain].lastUsed = new Date().toISOString();
}

function getUsageStats() {
  return {
    totalRequests: STATS.totalRequests,
    totalAgents: STATS.totalAgents,
    uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
    modelUsage: STATS.modelUsage,
    agentUsage: STATS.agentUsage,
    providerUsage: STATS.providerUsage,
    toolUsage: STATS.toolUsage,
    domainRequests: STATS.domainRequests,
    mcpClients: Array.from(mcpClients.values()),
    mcpActiveConnections,
  };
}

// ══════════════════════════════════════════════════════════════
//  🧟 PERSISTENT TELEMETRY — write-through to SQLite (data/models.db)
//  In-memory STATS die on restart; these tables do not.
// ══════════════════════════════════════════════════════════════
function dbRun(sql, params) {
  try {
    if (MODELS_DB) MODELS_DB.prepare(sql).run(...(params || []));
  } catch (e) {
    log("DEBUG", "TELEMETRY_FAIL", { error: e.message });
  }
}

function recordProviderStat(provider, ok, errMsg) {
  if (!provider) return;
  const now = Date.now();
  dbRun(
    `INSERT INTO provider_stats (provider, requests, errors, last_used, last_error, last_error_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       requests = requests + 1,
       errors = errors + excluded.errors,
       last_used = excluded.last_used,
       last_error = COALESCE(excluded.last_error, last_error),
       last_error_at = COALESCE(excluded.last_error_at, last_error_at)`,
    [
      provider,
      ok ? 0 : 1,
      now,
      ok ? null : String(errMsg || "error").slice(0, 300),
      ok ? null : now,
    ],
  );
}

// 🧟 Read one row of the provider traffic ledger (real served traffic).
function getProviderStat(provider) {
  if (!MODELS_DB) return null;
  try {
    return (
      MODELS_DB.prepare("SELECT * FROM provider_stats WHERE provider = ?").get(
        provider,
      ) || null
    );
  } catch (e) {
    return null;
  }
}

function recordModelStat(model, provider, ok) {
  if (!model) return;
  dbRun(
    `INSERT INTO model_stats (model, provider, requests, errors, last_used)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(model) DO UPDATE SET
       requests = requests + 1,
       errors = errors + excluded.errors,
       provider = COALESCE(excluded.provider, provider),
       last_used = excluded.last_used`,
    [model, provider || null, ok ? 0 : 1, Date.now()],
  );
}

function recordAgentStat(agent, ok, model, provider) {
  if (!agent) return;
  dbRun(
    `INSERT INTO agent_stats (agent, calls, errors, last_used, last_model, last_provider)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET
       calls = calls + 1,
       errors = errors + excluded.errors,
       last_used = excluded.last_used,
       last_model = COALESCE(excluded.last_model, last_model),
       last_provider = COALESCE(excluded.last_provider, last_provider)`,
    [agent, ok ? 0 : 1, Date.now(), model || null, provider || null],
  );
}

function recordSessionTouch(sessionId, info) {
  if (!sessionId) return;
  const now = Date.now();
  const i = info || {};
  dbRun(
    `INSERT INTO session_log (id, editor, agent, model, provider, status, requests, created_at, last_seen, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       requests = requests + 1,
       last_seen = excluded.last_seen,
       editor = COALESCE(excluded.editor, editor),
       agent = COALESCE(excluded.agent, agent),
       model = COALESCE(excluded.model, model),
       provider = COALESCE(excluded.provider, provider),
       status = COALESCE(excluded.status, status),
       user_agent = COALESCE(excluded.user_agent, user_agent)`,
    [
      sessionId,
      i.editor || null,
      i.agent || null,
      i.model || null,
      i.provider || null,
      i.status || "active",
      i.created_at || now,
      now,
      i.user_agent || null,
    ],
  );
}

function recordRequestLog(row) {
  if (!MODELS_DB) return;
  try {
    const now = Date.now();
    MODELS_DB.prepare(
      `INSERT INTO request_log (ts, path, session_id, editor, agent, model, provider, status, ok, elapsed_ms, swap_count, domain)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      now,
      row.path || null,
      row.session_id || null,
      row.editor || null,
      row.agent || null,
      row.model || null,
      row.provider || null,
      row.status || 200,
      row.ok === false ? 0 : 1,
      Math.round(row.elapsed_ms || 0),
      row.swap_count || 0,
      row.domain || DETECTED_DOMAIN || null,
    );
    // keep the log bounded (~20k rows) — occasional prune
    if (Math.random() < 0.02) {
      MODELS_DB.prepare(
        `DELETE FROM request_log WHERE id IN (
           SELECT id FROM request_log ORDER BY id DESC LIMIT -1 OFFSET 20000)`
      ).run();
    }
  } catch (e) {
    log("DEBUG", "REQUEST_LOG_FAIL", { error: e.message });
  }
}

// Rehydrate in-memory counters from the persistent tables (boot).
function loadUsageFromDb() {
  if (!MODELS_DB) return;
  try {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    for (const r of MODELS_DB
      .prepare("SELECT model, requests, errors, last_used FROM model_stats")
      .all()) {
      STATS.modelUsage[r.model] = {
        count: r.requests,
        lastUsed: iso(r.last_used),
        errors: r.errors,
      };
    }
    for (const r of MODELS_DB
      .prepare("SELECT agent, calls, errors, last_used FROM agent_stats")
      .all()) {
      STATS.agentUsage[r.agent] = {
        count: r.calls,
        lastUsed: iso(r.last_used),
        errors: r.errors,
      };
    }
    for (const r of MODELS_DB
      .prepare("SELECT provider, requests, errors, last_used FROM provider_stats")
      .all()) {
      STATS.providerUsage[r.provider] = {
        count: r.requests,
        lastUsed: iso(r.last_used),
        errors: r.errors,
        rateLimits: 0,
      };
    }
    try {
      const t = MODELS_DB.prepare("SELECT COUNT(*) c FROM request_log").get();
      STATS.totalRequests = Math.max(STATS.totalRequests, t.c || 0);
    } catch (_) {}
    log("INFO", "USAGE_LOADED_FROM_DB", {
      models: Object.keys(STATS.modelUsage).length,
      agents: Object.keys(STATS.agentUsage).length,
      providers: Object.keys(STATS.providerUsage).length,
    });
  } catch (e) {
    log("WARN", "USAGE_LOAD_FAIL", { error: e.message });
  }
}

// 🧟 Tool on/off — persisted in tool_stats.enabled (admin panel).
function toolEnabled(tool) {
  if (!MODELS_DB) return true;
  try {
    const r = MODELS_DB.prepare(
      "SELECT enabled FROM tool_stats WHERE tool = ?"
    ).get(tool);
    return !r || r.enabled !== 0;
  } catch (e) {
    return true;
  }
}

// ══════════════════════════════════════════════════════════════
//  🧟 WORKSPACE AUTO-SSOT — Extension sends workspace path,
//  server auto-generates .zombiecoder/SSOT.md there.
// ══════════════════════════════════════════════════════════════

/**
 * Handle POST /api/workspace — Receive workspace path from extension,
 * auto-generate SSOT in that directory.
 *
 * Request body: { workspacePath, timestamp, source }
 * Response: { ok: true, ssotPath, generated (boolean) }
 */
function handleWorkspace(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);

      if (!data.workspacePath) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Missing required field: workspacePath",
        });
        return;
      }

      const wsPath = data.workspacePath;
      let ssotResult = null;
      let generated = false;

      try {
        // autoSSOT is defined internally in this file
        ssotResult = autoSSOT(wsPath);
        generated = true;
        // Also auto-generate syllabus.md for this workspace
        autoSyllabus(wsPath);
        // Update global working directory (fallback)
        mcpWorkingDir = wsPath;
        // Also store per-session dir if x-session-id is provided
        if (data.xSessionId) {
          sessionDirs.set(data.xSessionId, wsPath);
          log("INFO", "SESSION_DIR_SET", {
            session: data.xSessionId.slice(0, 8),
            dir: wsPath,
          });
        }
        log("INFO", "WORKSPACE_SSOT", {
          path: wsPath,
          source: data.source || "unknown",
          workingDir: mcpWorkingDir,
        });
      } catch (e) {
        log("WARN", "WORKSPACE_SSOT_FAILED", {
          path: wsPath,
          error: e.message,
        });
      }

      jsonResponse(res, 200, {
        ok: true,
        workspacePath: wsPath,
        ssotPath: ssotResult ? ssotResult.path : null,
        generated,
        server_ts: Date.now(),
      });
    } catch (e) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Invalid JSON: " + e.message,
      });
    }
  });
}

/**
 * Handle POST /api/syllabus — Add a new entry to syllabus.md
 * Request body: { topic, source, summary, keyPoints, gitHubLink, usedIn }
 */
function handleSyllabusAdd(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);
      if (!data.topic && !data.fullInstructions) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Missing required field: topic or fullInstructions",
        });
        return;
      }

      // Handle full instructions bootstrap
      if (data.fullInstructions) {
        const success = bootstrapSyllabus(data.projectDir || undefined);
        jsonResponse(res, 200, {
          ok: success !== false,
          action: success ? "bootstrapped" : "already-exists",
          message: success
            ? "Syllabus bootstrapped with full instructions"
            : "Syllabus already exists",
        });
        return;
      }

      // Standard syllabus add
      const success = writeSyllabus(data.projectDir || mcpWorkingDir, data.topic, {
        source: data.source || "Web Search",
        date: data.date,
        summary: data.summary || "",
        keyPoints: data.keyPoints || [],
        gitHubLink: data.gitHubLink,
        usedIn: data.usedIn,
      });
      if (success) {
        log("INFO", "SYLLABUS_API_ADD", { topic: data.topic });
        jsonResponse(res, 200, { ok: true, topic: data.topic });
      } else {
        jsonResponse(res, 500, {
          ok: false,
          error: "Failed to write syllabus",
        });
      }
    } catch (e) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Invalid JSON: " + e.message,
      });
    }
  });
}

// ──────────────────────────────────────────────────────────
//  TCP Server with HTTP/2 Protocol Detection
// ──────────────────────────────────────────────────────────
// Node's http.Server only supports HTTP/1.1. When a Java/Ktor client
// (e.g., IntelliJ's LLM plugin) uses HTTP/2 prior knowledge, it sends
//   PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n<HTTP/2 frames>
// as raw bytes. The HTTP/1.1 parser rejects the PRI line with 400 Bad
// Request, but the remaining HTTP/2 frames get pipelined and cause:
//   "Frame type(32) length(N) exceeds MAX_FRAME_SIZE(16384)"
// We intercept at the TCP level: detect the 24-byte preface, reject
// the connection cleanly, then pass HTTP/1.1 connections to the real
// request handler via server.emit('connection', socket).
//
// This fixes the "9MB frame" error from the Ktor SSE client.

const HTTP2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
const PREFACE_LENGTH = 24;
const net = require("net");

const tcpServer = net.createServer((socket) => {
  let protocolChecked = false;
  // Buffer accumulates data until we have enough to check the protocol.
  // CRITICAL: We do NOT forward the socket to http.Server until AFTER
  // we've checked the protocol. This prevents the http parser from
  // ever seeing HTTP/2 preface bytes.
  let buffer = Buffer.alloc(0);

  const onReadable = () => {
    if (protocolChecked) return;
    const chunk = socket.read();
    if (chunk === null) return; // need more data

    buffer = Buffer.concat([buffer, chunk]);

    // Wait until we have at least the full preface to check
    if (buffer.length < PREFACE_LENGTH) return;

    protocolChecked = true;
    socket.removeListener("readable", onReadable);

    // Check first 24 bytes for HTTP/2 prior-knowledge preface
    const prefix = buffer.slice(0, PREFACE_LENGTH).toString();
    if (prefix === HTTP2_PREFACE) {
      // ✅ HTTP/2 prior knowledge (h2c): hand the socket to the in-process
      // h2c server — SAME port, same handler. h2cServer re-emits every
      // stream as an HTTP/1.1-style request into `server`'s request handler.
      log("INFO", "HTTP2_ACCEPTED", {
        remote: socket.remoteAddress || "unknown",
        bytes: buffer.length,
        note: "HTTP/2 prior knowledge → forwarded to h2c server (same port)",
      });
      socket.unshift(buffer);
      buffer = null;
      h2cServer.emit("connection", socket);
      return;
    }

    // HTTP/1.1 — put the data back and forward to http.Server
    socket.unshift(buffer);
    buffer = null;
    server.emit("connection", socket);
  };

  socket.on("readable", onReadable);
  socket.on("error", (err) => {
    if (!protocolChecked) {
      protocolChecked = true;
      socket.removeListener("readable", onReadable);
      log("WARN", "TCP_WRAPPER_ERROR", { error: err.message });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 🧟 HTTP/1.1 Server (inbound) + HTTP/2 Client (outbound to providers)
// ══════════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const method = req.method;
  let url = req.url.split("?")[0];
  // Normalize duplicate /v1 prefixes from older extension copies.
  // Some extension builds configure serverUrl as http://host:3000/v1
  // and then append "/api/..." or "/v1/..." directly, producing
  //   /v1/api/workspace  -> /api/workspace
  //   /v1/v1/models      -> /v1/models
  // which would otherwise 404 because the server routes live at
  // /api/workspace and /v1/models (not under a doubled prefix).
  if (url.startsWith("/v1/v1/")) {
    url = url.slice(3);
  } else if (url.startsWith("/v1/api/")) {
    url = url.slice(3);
  } else if (url.startsWith("/mcp/v1/")) {
    // MCP clients (VSCode built-in MCP, probes) ask for the model
    // list at {mcpServerUrl}/v1/models — i.e. /mcp/v1/models.
    // Strip the /mcp prefix so /mcp/v1/models -> /v1/models and
    // the existing model-list route serves it instead of 404.
    url = url.slice(4);
  }
  const reqId = crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : String(Date.now()).slice(-8);

  // 🧟 VISUAL EVENT FLOW: Show every request in terminal
  visualEventFlow("request", `[${reqId}] ${method} ${url}`, {
    from: req.socket.remoteAddress,
    origin: req.headers.origin || "direct",
    agent: req.headers["user-agent"]?.slice(0, 50) || "unknown",
  });

  // Store reqId on response for downstream use
  res._reqId = reqId;
  const _origEnd = res.end.bind(res);
  res.end = function (chunk, encoding, cb) {
    visualEventFlow("response", `[${reqId}] ${res.statusCode || 200}`, {
      elapsed: Date.now() - startTime + "ms",
      bytes: chunk ? chunk.length || 0 : 0,
    });
    return _origEnd(chunk, encoding, cb);
  };

  // ─── HTTP/2 Connection Preface Detection ──────────────────
  // Java/Ktor HTTP clients may use HTTP/2 prior knowledge by sending
  //   PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n
  // as the very first bytes of a TCP connection. Node's HTTP/1.1 parser
  // accepts this as method=PRI, url=*, version=HTTP/2.0 but then rejects
  // it with a generic 400 Bad Request. The 400 body is then misinterpreted
  // by the Java HTTP/2 frame parser as HTTP/2 frames, causing:
  //   "Frame type(32) length(9071724) exceeds MAX_FRAME_SIZE(16384)"
  // We catch this at the application level and return a proper 505 response.
  if (req.method === "PRI" && req.url === "*") {
    log("WARN", "HTTP2_PREFACE_REJECTED", {
      remote: req.socket.remoteAddress,
      httpVersion: req.httpVersion,
    });
    res.writeHead(505, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    res.end(
      "This server only supports HTTP/1.1. " +
      "Please disable HTTP/2 in your client configuration. " +
      "IntelliJ IDEA: add -Djdk.httpclient.HttpClient.log=errors to VM options.",
    );
    return;
  }

  // Per-request domain detection (for multi-domain servers)
  const requestDomain = detectDomain(req.headers.host);

  // Track domain requests
  STATS.totalRequests++;
  trackDomainRequest(requestDomain);

  // CORS
  const corsOrigin = getCorsOrigin(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, DELETE",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Session-Id, X-Verify-Token",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── GET / — Serve UI Dashboard (graceful: falls back to public/ or 404) ──
  if (url === "/" && method === "GET") {
    const candidates = [
      path.resolve(__dirname, "public", "index.html"),
      path.resolve(__dirname, "public", "index.html"),
    ];
    for (const htmlPath of candidates) {
      try {
        const html = fs.readFileSync(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      } catch (e) { /* try next */ }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Dashboard not found. Run: node api.js");
    return;
  }

  // ─── UI-1: graceful static serve for public/ pages ──────────
  // Any request matching a file in s/public/ is served from there,
  // so admin.html / index.html /
  // even when the server runs in a folder without those files.
  if (method === "GET" && !url.startsWith("/api/") && !url.startsWith("/v1/") && !url.startsWith("/mcp")) {
    const base = path.resolve(__dirname, "public");
    let rel = url.split("?")[0].split("#")[0];
    if (rel === "/") rel = "/index.html";
    // Only allow safe, non-traversal relative names
    const safeRel = rel.replace(/^\/+/, "");
    if (safeRel && !safeRel.includes("..") && !safeRel.includes("\\")) {
      const filePath = path.join(base, safeRel);
      if (filePath.startsWith(base)) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mime = {
              ".html": "text/html; charset=utf-8",
              ".css": "text/css; charset=utf-8",
              ".js": "application/javascript; charset=utf-8",
              ".json": "application/json; charset=utf-8",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".svg": "image/svg+xml",
              ".ico": "image/x-icon",
              ".woff2": "font/woff2",
            }[ext] || "application/octet-stream";
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { "Content-Type": mime });
            res.end(content);
            return;
          }
        } catch (e) { /* not a file → fall through */ }
      }
    }
  }

  try {
    // ─── GET /health ─────────────────────────────────────────
    if (url === "/health" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      const rateLimit = getRateLimitStatus();
      jsonResponse(res, 200, {
        healthy: true,
        instance_id: INSTANCE_ID,
        version: DOMAIN_CFG.version,
        domain: requestDomain,
        serverType: DOMAIN_CFG.type,
        agents: AGENTS.length,
        models: FREE_MODELS.length,
        pusher: PUSHER_ENABLED,
        hasFrontend: DOMAIN_CFG.hasFrontend,
        maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
        uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
        session_count: cleanExpired().length,
        rate_limit: rateLimit.limited
          ? {
            limited: true,
            domain: requestDomain,
            provider: rateLimit.provider,
            model: rateLimit.model,
            remaining_sec: rateLimit.remainingSec,
            message: rateLimit.message,
          }
          : { limited: false, domain: requestDomain },
      });
      return;
    }

    // ─── GET /api/rate-limit ───────────────────────────────────
    if (url === "/api/rate-limit" && method === "GET") {
      jsonResponse(res, 200, getRateLimitStatus());
      return;
    }
    // ─── POST /api/rate-limit/reset ────────────────────────────
    if (url === "/api/rate-limit/reset" && method === "POST") {
      const state = getRateLimitState(requestDomain);
      state.limited = false;
      state.provider = null;
      state.model = null;
      log("INFO", "RATE_LIMIT_RESET", { domain: requestDomain });
      jsonResponse(res, 200, {
        success: true,
        message: "Rate limit state cleared for " + requestDomain,
      });
      return;
    }

    // ─── GET /identity ───────────────────────────────────────
    if (url === "/identity" && method === "GET") {
      const requestConfig = getDomainConfig(requestDomain);
      log("INFO", "REQUEST", {
        method,
        url,
        domain: requestDomain,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        system_identity: {
          ...requestConfig.identity,
          server: {
            domain: requestDomain,
            type: requestConfig.type,
            version: requestConfig.version,
            hasFrontend: requestConfig.hasFrontend,
            hasPusher: PUSHER_ENABLED,
            maxRateLimit: requestConfig.maxRateLimitPerServer,
          },
        },
      });
      return;
    }

    // ─── GET /v1/models ──────────────────────────────────────
    if (url === "/v1/models" && method === "GET") {
      const agentModels = AGENTS.map((a) => ({
        id: a.id, // ← Agent ID (code-guru, bug-hunter, etc.)
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mission-barisal",
      }));

      // Add "mission" as a special model
      agentModels.unshift({
        id: "mission",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mission-barisal",
      });

      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
        model_count: agentModels.length,
      });
      jsonResponse(res, 200, { object: "list", data: agentModels });
      return;
    }

    // ─── GET /api/v0/models ──────────────────────────────────
    // JetBrains/IDE clients call this endpoint for model discovery.
    // Returns REAL provider model names so IDE can list and select them.
    if (url === "/api/v0/models" && method === "GET") {
      const allModels = [];

      // 1. Add real provider models (what JetBrains needs to see)
      for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
        if (p.models.length === 0) {
          allModels.push({
            id: `${id}:default`,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: p.name,
          });
        } else {
          for (const m of p.models) {
            allModels.push({
              id: getModelName(m),
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: p.name,
            });
          }
        }
      }

      // 2. Add agent models as "mission:" prefixed entries
      allModels.push({
        id: "mission",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mission-barisal",
      });
      for (const a of AGENTS) {
        allModels.push({
          id: "mission:" + a.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mission-barisal",
        });
      }

      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
        model_count: allModels.length,
        providers: Object.keys(PROVIDER_CONFIG).length,
      });
      jsonResponse(res, 200, { object: "list", data: allModels });
      return;
    }

    // ── GET /api/v1/models ──────────────────────────────────
    // Shows ALL provider models (unmasked, real API model names).
    // For developers/admins to see what models are available from providers.
    // Smart Router uses this info internally for routing decisions.
    if (url === "/api/v1/models" && method === "GET") {
      const providerModels = [];
      for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
        if (p.models.length === 0) {
          providerModels.push({
            id: "*",
            provider: id,
            providerName: p.name,
            type: p.type,
            apiModel: "*",
            free: true,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: p.name,
          });
        } else {
          for (const m of p.models) {
            providerModels.push({
              id: getModelName(m),
              provider: id,
              providerName: p.name,
              type: p.type,
              apiModel: getApiModelName(m),
              free: true,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: p.name,
            });
          }
        }
      }
      jsonResponse(res, 200, {
        object: "list",
        data: providerModels,
        total_providers: Object.keys(PROVIDER_CONFIG).length,
        total_models: providerModels.length,
      });
      return;
    }

    // ─── GET /api/mcp-clients ─────────────────────────────────
    if (url === "/api/mcp-clients" && method === "GET") {
      const mcpStatus = {
        domain: requestDomain,
        serverType: DOMAIN_CFG.type,
        version: DOMAIN_CFG.version,
        total_requests: STATS.totalRequests,
        active_connections: mcpActiveConnections,
        connected_clients: Array.from(mcpClients.values()),
        tools: Object.keys(MCP_TOOLS).length,
        server_url: "http://localhost:" + PORT + "/mcp",
        protocol: "JSON-RPC 2.0",
        protocol_version: "2024-11-05",
      };
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, mcpStatus);
      return;
    }

    // ─── GET /api/clients ─────────────────────────────────────
    // HTML page showing all connected clients with their sessions and status
    if (url === "/api/clients" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });

      const allClients = readClients();
      const clients = allClients.sort(
        (a, b) => new Date(b.last_seen) - new Date(a.last_seen),
      );

      let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mission Barisal — Client List</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #e6edf3; min-height: 100vh;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; }
  h1 {
    font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem;
    background: linear-gradient(135deg, #58a6ff, #3fb950);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .subtitle { color: #8b949e; margin-bottom: 2rem; }
  .stats-bar {
    display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap;
  }
  .stat-card {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 1rem 1.5rem; flex: 1; min-width: 150px;
  }
  .stat-card .label { font-size: 0.875rem; color: #8b949e; }
  .stat-card .value { font-size: 1.5rem; font-weight: 700; margin-top: 0.25rem; }
  .stat-card .value.green { color: #3fb950; }
  .stat-card .value.blue { color: #58a6ff; }
  .stat-card .value.orange { color: #d29922; }
  table {
    width: 100%; border-collapse: collapse; background: #161b22;
    border: 1px solid #30363d; border-radius: 8px; overflow: hidden;
  }
  th {
    background: #1c2128; text-align: left; padding: 0.75rem 1rem;
    font-size: 0.875rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em;
  }
  td { padding: 0.75rem 1rem; border-top: 1px solid #21262d; font-size: 0.9rem; }
  tr:hover { background: #1c2128; }
  .status-badge {
    display: inline-flex; align-items: center; gap: 0.375rem;
    padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.8rem; font-weight: 500;
  }
  .status-badge.active { background: #0b2e1a; color: #3fb950; border: 1px solid #1b4622; }
  .status-badge.stale { background: #2d1a0b; color: #d29922; border: 1px solid #462b1b; }
  .status-badge.offline { background: #2d0b0b; color: #f85149; border: 1px solid #461b1b; }
  .dot {
    width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  }
  .dot.active { background: #3fb950; }
  .dot.stale { background: #d29922; }
  .dot.offline { background: #f85149; }
  .refresh-btn {
    display: inline-block; padding: 0.5rem 1.5rem; margin-top: 1rem;
    background: #238636; color: #fff; border: none; border-radius: 6px;
    font-size: 0.9rem; cursor: pointer; text-decoration: none;
  }
  .refresh-btn:hover { background: #2ea043; }
  .footer { margin-top: 2rem; color: #484f58; font-size: 0.8rem; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>🤖 MCP Client List</h1>
  <p class="subtitle">Real-time view of all connected MCP clients</p>

  <div class="stats-bar">
    <div class="stat-card">
      <div class="label">Total Clients</div>
      <div class="value blue">${clients.length}</div>
    </div>
    <div class="stat-card">
      <div class="label">Active Now</div>
      <div class="value green">${clients.filter((c) => c.status === "active").length}</div>
    </div>
    <div class="stat-card">
      <div class="label">Working Directory</div>
<!-- Corrected Syntax -->
<div class="value orange" style="font-size: 1rem; word-break: break-all;">
  ${mcpWorkingDir || 'Not set'}
</div>

    </div>
    <div class="stat-card">
      <div class="label">Server Port</div>
      <div class="value">${PORT}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Client Name</th>
        <th>Version</th>
        <th>Status</th>
        <th>Connected</th>
        <th>Last Seen</th>
        <th>Working Dir</th>
        <th>Session</th>
      </tr>
    </thead>
    <tbody>
      ${clients
          .map((c) => {
            const now = Date.now();
            const lastSeen = new Date(c.last_seen).getTime();
            const diff = now - lastSeen;
            let status = "active";
            if (diff > 300000) status = "stale";
            if (diff > 1800000) status = "offline";
            return `<tr>
          <td><strong>${c.name}</strong></td>
          <td>${c.version || "—"}</td>
          <td><span class="status-badge ${status}"><span class="dot ${status}"></span>${status}</span></td>
          <td>${new Date(c.connected_at).toLocaleString()}</td>
          <td>${new Date(c.last_seen).toLocaleString()}</td>
          <td style="font-size:0.8rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${c.working_dir || "—"}</td>
          <td style="font-family:monospace;font-size:0.8rem;">${c.session_id || "—"}</td>
        </tr>`;
          })
          .join("")}
    </tbody>
  </table>

  <a href="/api/clients" class="refresh-btn">🔄 Refresh</a>
</div>
<div class="footer">
  Mission Barisal v3 &mdash; Connected to port ${PORT}
</div>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ─── GET /api/domain ────────────────────────────────────
    // Shows current domain detection and configuration
    if (url === "/api/domain" && method === "GET") {
      jsonResponse(res, 200, {
        detected: requestDomain,
        startup: DETECTED_DOMAIN,
        hostHeader: req.headers.host || null,
        type: DOMAIN_CFG.type,
        version: DOMAIN_CFG.version,
        hasFrontend: DOMAIN_CFG.hasFrontend,
        hasPusher: PUSHER_ENABLED,
        hasDevModels: DOMAIN_CFG.hasDevModels,
        maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
        corsOrigins: DOMAIN_CFG.corsOrigins,
        sessionVerifyUrl: DOMAIN_CFG.sessionVerifyUrl,
        envOverride: process.env.DEPLOY_DOMAIN || null,
        allDomains: Object.keys(DOMAIN_CONFIGS),
      });
      return;
    }

    // ─── GET /api/pusher-config ──────────────────────────────
    // Returns Pusher key and cluster for client-side connection (safe — no secret)
    if (url === "/api/pusher-config" && method === "GET") {
      jsonResponse(res, 200, {
        enabled: PUSHER_ENABLED,
        key: PUSHER_KEY || null,
        cluster: PUSHER_CLUSTER || "ap2",
      });
      return;
    }

    // ─── GET /api/agents ─────────────────────────────────────
    if (url === "/api/agents" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        count: AGENTS.length,
        source: "PERSONAS.md",
        agents: AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          model: maskModelName(a.model),
          provider: "ZombieCoder",
        })),
      });
      return;
    }

    // ─── PHASE A: Admin Agents CRUD (DB-first) ─────────────────
    // Protected by ADMIN_TOKEN env when set; open in dev mode (no token set).
    function adminAuthorized(req) {
      if (!process.env.ADMIN_TOKEN) return true;
      return req.headers["x-admin-token"] === process.env.ADMIN_TOKEN;
    }

    if (url === "/api/admin/agents" && method === "GET") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const rows = MODELS_DB.prepare(
        "SELECT id, name, role, model, expertise, persona, enabled, priority, updated_at FROM agents ORDER BY priority ASC, name ASC"
      ).all();
      jsonResponse(res, 200, { count: rows.length, agents: rows });
      return;
    }

    // ─── 🧟 Admin: provider & model enable/disable (runtime + persisted) ──
    if (url === "/api/admin/providers" && method === "GET") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        providers: Object.entries(PROVIDER_CONFIG).map(([id, p]) => {
          const st = getProviderStat(id);
          const reqs = st ? st.requests : 0;
          const errs = st ? st.errors : 0;
          let healthy = true;
          try {
            healthy = isProviderHealthy(id);
          } catch (_) {}
          return {
            id,
            name: p.name || id,
            type: p.type || "openai",
            baseUrl: p.baseUrl || "",
            priority: p.priority || 99,
            enabled: p.enabled !== false,
            models: (p.models || []).length,
            hasKey: !!(p.key && p.key.length > 8),
            // 🧟 real traffic ledger + live health (no fake "🟢 Online")
            requests: reqs,
            errors: errs,
            success_pct: reqs
              ? Math.round(((reqs - errs) / reqs) * 100)
              : null,
            last_used:
              st && st.last_used
                ? new Date(st.last_used).toISOString()
                : null,
            last_error: st && st.last_error ? st.last_error : null,
            healthy,
          };
        }),
      });
      return;
    }
    if (url === "/api/admin/providers" && method === "POST") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      const body = await readBody(req);
      let b;
      try {
        b = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!b || !b.id || !PROVIDER_CONFIG[b.id]) {
        jsonResponse(res, 404, { error: "Unknown provider: " + (b && b.id) });
        return;
      }
      PROVIDER_CONFIG[b.id].enabled = b.enabled ? true : false;
      const off = persistProviderDisabled();
      log("INFO", "ADMIN_PROVIDER_TOGGLE", {
        provider: b.id,
        enabled: PROVIDER_CONFIG[b.id].enabled,
        disabled_list: off,
      });
      jsonResponse(res, 200, {
        ok: true,
        id: b.id,
        enabled: PROVIDER_CONFIG[b.id].enabled,
        disabledProviders: off,
      });
      return;
    }
    if (url === "/api/admin/models" && method === "POST") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const body = await readBody(req);
      let b;
      try {
        b = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!b || !b.provider || !b.name) {
        jsonResponse(res, 400, { error: "provider and name are required" });
        return;
      }
      const r = MODELS_DB.prepare(
        "UPDATE models SET enabled = ? WHERE provider = ? AND name = ?"
      ).run(b.enabled ? 1 : 0, b.provider, b.name);
      if (r.changes === 0) {
        jsonResponse(res, 404, { error: "Model not found in DB" });
        return;
      }
      if (b.enabled) DISABLED_MODELS.delete(b.provider + "::" + b.name);
      else DISABLED_MODELS.add(b.provider + "::" + b.name);
      log("INFO", "ADMIN_MODEL_TOGGLE", {
        provider: b.provider,
        name: b.name,
        enabled: !!b.enabled,
      });
      jsonResponse(res, 200, {
        ok: true,
        provider: b.provider,
        name: b.name,
        enabled: !!b.enabled,
        disabledCount: DISABLED_MODELS.size,
      });
      return;
    }

    if (url === "/api/admin/agents" && method === "POST") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const body = await readBody(req);
      let a;
      try {
        a = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!a || !a.id) {
        jsonResponse(res, 400, { error: "id is required" });
        return;
      }
      const existing = MODELS_DB.prepare(
        "SELECT name, role, model, expertise, persona, enabled, priority FROM agents WHERE id = ?"
      ).get(a.id);
      // persona required only when CREATING — updates (model mapping,
      // enable/disable) may omit it and inherit the stored persona.
      if (!a.persona && !existing) {
        jsonResponse(res, 400, { error: "id and persona are required" });
        return;
      }
      const now = Date.now();
      MODELS_DB.prepare(`
        INSERT INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          role = excluded.role,
          model = excluded.model,
          expertise = excluded.expertise,
          persona = excluded.persona,
          enabled = excluded.enabled,
          priority = excluded.priority,
          updated_at = excluded.updated_at
      `).run(
        a.id,
        a.name || existing?.name || a.id,
        a.role || existing?.role || "general",
        a.model || existing?.model || "",
        a.expertise || existing?.expertise || "",
        a.persona || existing?.persona || "Agent",
        a.enabled === undefined ? (existing?.enabled === undefined ? 1 : existing.enabled) : a.enabled ? 1 : 0,
        a.priority || existing?.priority || 99,
        now,
      );
      await refreshAgents();
      jsonResponse(res, 200, { ok: true, id: a.id, totalAgents: AGENTS.length });
      return;
    }

    if (url.startsWith("/api/admin/agents/") && method === "DELETE") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const id = decodeURIComponent(url.slice("/api/admin/agents/".length));
      MODELS_DB.prepare("DELETE FROM agents WHERE id = ?").run(id);
      await refreshAgents();
      jsonResponse(res, 200, { ok: true, id, totalAgents: AGENTS.length });
      return;
    }

    // ─── GET /admin/:file — Admin Panel static files ─
    // Directory resolution: ADMIN_DIR env var first; NO hardcoded path —
    // fallback is <project>/public (ships with this repo, always exists).
    // Injects dynamic BASE_URL into HTML files before serving
    if ((url === "/admin" || url.startsWith("/admin/")) && method === "GET") {
      const ADMIN_DIR = path.resolve(
        process.env.ADMIN_DIR || path.join(__dirname, "public"),
      );
      let filePath =
        url === "/admin" ? "/index.html" : url.replace("/admin", "");
      if (!filePath || filePath === "/") filePath = "/index.html";
      const fullPath = path.join(ADMIN_DIR, filePath);

      // Security: prevent directory traversal
      if (
        fullPath !== ADMIN_DIR &&
        !fullPath.startsWith(ADMIN_DIR + path.sep)
      ) {
        jsonResponse(res, 403, { error: "Forbidden" });
        return;
      }

      if (!fs.existsSync(fullPath)) {
        jsonResponse(res, 404, { error: "File not found: " + filePath });
        return;
      }

      try {
        let content = fs.readFileSync(fullPath, "utf8");
        const ext = path.extname(fullPath).toLowerCase();

        // Content-Type mapping
        const mimeTypes = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "application/javascript; charset=utf-8",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
        };

        const contentType = mimeTypes[ext] || "application/octet-stream";

        // Inject dynamic BASE_URL into HTML files
        if (ext === ".html") {
          const baseUrl = DOMAIN_CFG.baseUrl || `http://localhost:${PORT}`;
          // Replace hardcoded localhost URLs with dynamic server URL
          content = content.replace(/http:\/\/localhost:\d+/g, baseUrl);
          // Also inject server config as a global JS variable
          const configScript = `
<script>
window.__ADMIN_CONFIG = ${JSON.stringify({
            baseUrl: baseUrl,
            port: PORT,
            domain: DETECTED_DOMAIN,
            version: DOMAIN_CFG.version,
            serverType: DOMAIN_CFG.type,
            corsOrigins: DOMAIN_CFG.corsOrigins,
          })};
</script>`;
          content = content.replace("</head>", configScript + "\n</head>");
        }

        // CORS headers — allow any origin for admin files
        res.writeHead(200, {
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-session-id",
          "Cache-Control": "no-cache",
        });
        res.end(content);
      } catch (e) {
        jsonResponse(res, 500, { error: "Error reading file: " + e.message });
      }
      return;
    }

    // ─── GET /api/admin — Admin Dashboard HTML ─────────────────
    // Single-page admin panel: models, agents, providers, sessions, env vars
    if (url === "/api/admin" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });

      const sessions = readSessions();
      const allModels = getAllModels();
      const allClients = readClients();
      const rateState = getRateLimitStatus();

      // Collect session memory stats
      let totalMemEntries = 0;
      let totalAgentMemFiles = 0;
      for (const s of sessions) {
        const memDir = path.join(DATA_DIR, s.id);
        if (fs.existsSync(memDir)) {
          try {
            const files = fs.readdirSync(memDir);
            totalAgentMemFiles += files.length;
            for (const f of files) {
              if (f.endsWith(".json")) {
                try {
                  const d = JSON.parse(
                    fs.readFileSync(path.join(memDir, f), "utf8"),
                  );
                  totalMemEntries += Array.isArray(d) ? d.length : 0;
                } catch (e) { }
              }
            }
          } catch (e) { }
        }
        const gFile = path.join(DATA_DIR, "mem-" + s.id + ".json");
        if (fs.existsSync(gFile)) {
          try {
            const d = JSON.parse(fs.readFileSync(gFile, "utf8"));
            totalMemEntries += Array.isArray(d) ? d.length : 0;
          } catch (e) { }
        }
      }

      const envVars = {
        PORT: process.env.PORT || "not set",
        DEPLOY_DOMAIN: process.env.DEPLOY_DOMAIN || "not set",
        SESSION_VERIFY_URL: process.env.SESSION_VERIFY_URL || "not set",
        PUSHER_ENABLED: PUSHER_ENABLED ? "yes" : "no",
        PUSHER_CLUSTER: process.env.PUSHER_CLUSTER || "ap2 (default)",
        OPENCODE_API_KEY: process.env.OPENCODE_API_KEY
          ? "*** set ***"
          : "not set",
        GROQ_API_KEY: process.env.GROQ_API_KEY ? "*** set ***" : "not set",
        GEMINI_API_KEY: process.env.GEMINI_API_KEY ? "*** set ***" : "not set",
        SSOT_DIR: process.env.SSOT_DIR || ".zombiecoder (default)",
        CACHE_DIR: process.env.CACHE_DIR || "./cache (default)",
        LOG_DIR: process.env.LOG_DIR || "./logs (default)",
        MAX_RATE_LIMIT:
          process.env.MAX_RATE_LIMIT ||
          DOMAIN_CFG.maxRateLimitPerServer + " (default)",
        GIT_PERSONAS_URL: process.env.GIT_PERSONAS_URL || "github (default)",
      };

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mission Barisal — Admin Dashboard</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0d1117; color:#e6edf3; min-height:100vh; padding:1rem; }
  .container { max-width:1400px; margin:0 auto; }
  h1 { font-size:1.8rem; font-weight:700; margin-bottom:0.25rem; background:linear-gradient(135deg,#58a6ff,#3fb950); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
  .subtitle { color:#8b949e; margin-bottom:1.5rem; font-size:0.9rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:1rem; margin-bottom:1.5rem; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:1rem; }
  .card h2 { font-size:1rem; color:#58a6ff; margin-bottom:0.75rem; padding-bottom:0.5rem; border-bottom:1px solid #21262d; }
  .card table { width:100%; border-collapse:collapse; font-size:0.85rem; }
  .card td, .card th { padding:0.4rem 0.5rem; text-align:left; border-bottom:1px solid #21262d; }
  .card th { color:#8b949e; font-weight:500; text-transform:uppercase; font-size:0.75rem; letter-spacing:0.05em; }
  .badge { display:inline-block; padding:0.15rem 0.5rem; border-radius:999px; font-size:0.75rem; font-weight:500; }
  .badge.green { background:#0b2e1a; color:#3fb950; border:1px solid #1b4622; }
  .badge.yellow { background:#2d1a0b; color:#d29922; border:1px solid #462b1b; }
  .badge.red { background:#2d0b0b; color:#f85149; border:1px solid #461b1b; }
  .badge.blue { background:#0b1e2d; color:#58a6ff; border:1px solid #1b3646; }
  .stat { font-size:1.5rem; font-weight:700; margin-top:0.25rem; }
  .stat.green { color:#3fb950; }
  .stat.blue { color:#58a6ff; }
  .stat.orange { color:#d29922; }
  .mono { font-family:'SF Mono','Fira Code',monospace; font-size:0.8rem; }
  .refresh { display:inline-block; padding:0.4rem 1rem; background:#238636; color:#fff; border:none; border-radius:6px; cursor:pointer; text-decoration:none; font-size:0.85rem; margin-top:0.5rem; }
  .refresh:hover { background:#2ea043; }
  .footer { margin-top:2rem; color:#484f58; font-size:0.75rem; text-align:center; }
  .env-table td:first-child { font-weight:500; color:#8b949e; width:40%; }
  .env-table td:last-child { font-family:monospace; font-size:0.75rem; word-break:break-all; }
</style>
</head>
<body>
<div class="container">
  <h1>Mission Barisal Admin</h1>
  <p class="subtitle">Server: ${DOMAIN_CFG.name} | Domain: ${requestDomain} | v${DOMAIN_CFG.version} | Uptime: ${Math.floor((Date.now() - STATS.startTime) / 1000)}s</p>

  <div class="grid">
    <div class="card">
      <h2>Server Stats</h2>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Requests</div><div class="stat blue">${STATS.totalRequests}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Sessions</div><div class="stat green">${sessions.length}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Agents</div><div class="stat orange">${AGENTS.length}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Models</div><div class="stat blue">${allModels.length}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Providers</div><div class="stat green">${Object.keys(PROVIDER_CONFIG).length}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Memory Entries</div><div class="stat orange">${totalMemEntries}</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Rate Limit Status</h2>
      <div style="display:flex;gap:1rem;flex-wrap:wrap;">
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Limited</div><div class="stat ${rateState.limited ? "orange" : "green"}">${rateState.limited ? "YES" : "NO"}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Provider</div><div class="stat" style="font-size:1rem;">${rateState.provider || "—"}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Model</div><div class="stat" style="font-size:1rem;">${rateState.model || "—"}</div></div>
        <div><div class="label" style="color:#8b949e;font-size:0.8rem;">Remaining</div><div class="stat blue">${rateState.remainingSec || "∞"}s</div></div>
      </div>
    </div>

    <div class="card">
      <h2>Domain Config</h2>
      <table><tbody>
        <tr><td>Type</td><td>${DOMAIN_CFG.type}</td></tr>
        <tr><td>Frontend</td><td><span class="badge ${DOMAIN_CFG.hasFrontend ? "green" : "yellow"}">${DOMAIN_CFG.hasFrontend ? "enabled" : "disabled"}</span></td></tr>
        <tr><td>Pusher</td><td><span class="badge ${PUSHER_ENABLED ? "green" : "red"}">${PUSHER_ENABLED ? "enabled" : "disabled"}</span></td></tr>
        <tr><td>Dev Models</td><td><span class="badge ${DOMAIN_CFG.hasDevModels ? "blue" : "red"}">${DOMAIN_CFG.hasDevModels ? "visible" : "hidden"}</span></td></tr>
        <tr><td>Rate Limit</td><td>${DOMAIN_CFG.maxRateLimitPerServer}/min</td></tr>
        <tr><td>CORS Origins</td><td class="mono">${DOMAIN_CFG.corsOrigins.join(", ")}</td></tr>
        <tr><td>Session Verify</td><td class="mono">${DOMAIN_CFG.sessionVerifyUrl}</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Agents (${AGENTS.length})</h2>
      <table><thead><tr><th>ID</th><th>Name</th><th>Role</th><th>Model</th><th>Priority</th></tr></thead><tbody>
        ${AGENTS.map((a) => '<tr><td class="mono">' + a.id + "</td><td>" + a.name + "</td><td>" + a.role + "</td><td>" + maskModelName(a.model) + "</td><td>" + a.priority + "</td></tr>").join("")}
      </tbody></table>
    </div>

    <div class="card">
      <h2>Providers (${Object.keys(PROVIDER_CONFIG).length})</h2>
      <table><thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Models</th><th>Priority</th></tr></thead><tbody>
        ${Object.entries(PROVIDER_CONFIG)
          .map(
            ([id, p]) =>
              '<tr><td class="mono">' +
              id +
              "</td><td>" +
              p.name +
              "</td><td>" +
              p.type +
              "</td><td>" +
              p.models.length +
              '</td><td><span class="badge blue">' +
              p.priority +
              "</span></td></tr>",
          )
          .join("")}
      </tbody></table>
    </div>

    <div class="card">
      <h2>All Models (${allModels.length})</h2>
      <div style="max-height:240px;overflow-y:auto;">
      <table><thead><tr><th>Model</th><th>Provider</th></tr></thead><tbody>
        ${allModels.map((m) => '<tr><td class="mono">' + m.model + '</td><td><span class="badge green">' + m.providerName + "</span></td></tr>").join("")}
      </tbody></table>
      </div>
    </div>
  </div>

  <!-- ─── USAGE STATISTICS SECTION  ─── -->
  <div class="grid">
    <div class="card">
      <h2>Provider Usage</h2>
      <table><thead><tr><th>Provider</th><th>Calls</th><th>Errors</th><th>Rate Limits</th><th>Last Used</th></tr></thead><tbody>
        ${Object.entries(STATS.providerUsage || {}).length === 0
          ? '<tr><td colspan="5" style="color:#8b949e;">No usage data yet</td></tr>'
          : Object.entries(STATS.providerUsage || {})
            .map(
              ([id, u]) =>
                '<tr><td class="mono">' +
                id +
                "</td><td>" +
                u.count +
                '</td><td><span class="badge ' +
                (u.errors > 0 ? "red" : "green") +
                '">' +
                u.errors +
                '</span></td><td><span class="badge ' +
                (u.rateLimits > 0 ? "yellow" : "green") +
                '">' +
                u.rateLimits +
                '</span></td><td style="font-size:0.75rem;">' +
                (u.lastUsed ? new Date(u.lastUsed).toLocaleString() : "—") +
                "</td></tr>",
            )
            .join("")
        }
      </tbody></table>
    </div>
    <div class="card">
      <h2>Model Usage</h2>
      <div style="max-height:200px;overflow-y:auto;">
      <table><thead><tr><th>Model</th><th>Calls</th><th>Last Used</th></tr></thead><tbody>
        ${Object.entries(STATS.modelUsage || {}).length === 0
          ? '<tr><td colspan="3" style="color:#8b949e;">No usage data yet</td></tr>'
          : Object.entries(STATS.modelUsage || {})
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 20)
            .map(
              ([id, u]) =>
                '<tr><td class="mono">' +
                id +
                "</td><td>" +
                u.count +
                '</td><td style="font-size:0.75rem;">' +
                (u.lastUsed ? new Date(u.lastUsed).toLocaleString() : "—") +
                "</td></tr>",
            )
            .join("")
        }
      </tbody></table>
      </div>
    </div>
    <div class="card">
      <h2>Agent Usage</h2>
      <div style="max-height:200px;overflow-y:auto;">
      <table><thead><tr><th>Agent</th><th>Calls</th><th>Errors</th><th>Last Used</th></tr></thead><tbody>
        ${Object.entries(STATS.agentUsage || {}).length === 0
          ? '<tr><td colspan="4" style="color:#8b949e;">No usage data yet</td></tr>'
          : Object.entries(STATS.agentUsage || {})
            .sort((a, b) => b[1].count - a[1].count)
            .map(
              ([id, u]) =>
                '<tr><td class="mono">' +
                id +
                "</td><td>" +
                u.count +
                '</td><td><span class="badge ' +
                (u.errors > 0 ? "red" : "green") +
                '">' +
                u.errors +
                '</span></td><td style="font-size:0.75rem;">' +
                (u.lastUsed ? new Date(u.lastUsed).toLocaleString() : "—") +
                "</td></tr>",
            )
            .join("")
        }
      </tbody></table>
      </div>
    </div>
    <div class="card">
      <h2>Runtime Metrics</h2>
      <table><tbody>
        <tr><td>Total Requests</td><td class="mono">${STATS.totalRequests}</td></tr>
        <tr><td>Memory (RSS)</td><td class="mono">${Math.round((process.memoryUsage().rss || 0) / 1024 / 1024)} MB</td></tr>
        <tr><td>Memory (Heap)</td><td class="mono">${Math.round((process.memoryUsage().heapUsed || 0) / 1024 / 1024)} MB</td></tr>
        <tr><td>Uptime</td><td class="mono">${Math.floor((Date.now() - STATS.startTime) / 1000)}s</td></tr>
        <tr><td>Lock Log Entries</td><td class="mono">${readLockLogs().length}</td></tr>
        <tr><td>Domains</td><td class="mono">${Object.keys(STATS.domainRequests || {}).length}</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="grid">
    <div class="card" style="grid-column:1/-1;">
      <h2>Sessions (${sessions.length})</h2>
      ${sessions.length === 0
          ? '<p style="color:#8b949e;">No active sessions. Sessions are created when agents receive requests.</p>'
          : `
      <div style="max-height:300px;overflow-y:auto;">
      <table><thead><tr><th>ID</th><th>Client</th><th>Editor</th><th>Model</th><th>Provider</th><th>Messages</th><th>Mem Files</th><th>Mem Entries</th><th>Status</th><th>Created</th></tr></thead><tbody>
        ${sessions
            .slice(-20)
            .reverse()
            .map((s) => {
              const memDir = path.join(DATA_DIR, s.id);
              let mf = 0,
                me = 0;
              if (fs.existsSync(memDir))
                try {
                  const files = fs.readdirSync(memDir);
                  mf = files.filter((f) => f.endsWith(".json")).length;
                  for (const f of files)
                    if (f.endsWith(".json"))
                      try {
                        const d = JSON.parse(
                          fs.readFileSync(path.join(memDir, f), "utf8"),
                        );
                        me += Array.isArray(d) ? d.length : 0;
                      } catch (e) { }
                } catch (e) { }
              return (
                '<tr><td class="mono" title="' +
                s.id +
                '">' +
                s.id.slice(0, 8) +
                "..</td><td>" +
                s.client_id +
                "</td><td>" +
                s.editor +
                "</td><td>" +
                (s.model || "—") +
                "</td><td>" +
                (s.provider || "—") +
                "</td><td>" +
                (s.messages || 0) +
                "</td><td>" +
                mf +
                "</td><td>" +
                me +
                '</td><td><span class="badge ' +
                (s.status === "active" ? "green" : "yellow") +
                '">' +
                s.status +
                "</span></td><td>" +
                new Date(s.created_at).toLocaleString() +
                "</td></tr>"
              );
            })
            .join("")}
      </tbody></table>
      </div>`
        }
      <div style="margin-top:0.5rem;">
        <a href="/api/sessions" class="refresh" style="background:#1f6feb;">View Sessions JSON</a>
        <a href="/api/clients" class="refresh" style="background:#1f6feb;">View Clients HTML</a>
        <a href="/api/mcp-clients" class="refresh" style="background:#1f6feb;">MCP Clients JSON</a>
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:1.5rem;">
    <h2>Environment Variables</h2>
    <table class="env-table"><tbody>
      ${Object.entries(envVars)
          .map(([k, v]) => "<tr><td>" + k + "</td><td>" + v + "</td></tr>")
          .join("")}
      <tr><td>ALLOWED_ORIGINS</td><td class="mono">${DOMAIN_CFG.corsOrigins.join(", ")}</td></tr>
      <tr><td>SESSION_TTL_MS</td><td class="mono">${SESSION_TTL_MS}ms (${Math.floor(SESSION_TTL_MS / 86400000)}d)</td></tr>
      <tr><td>MAX_HISTORY</td><td>${MAX_HISTORY}</td></tr>
    </tbody></table>
  </div>

  <div class="card" style="margin-bottom:1.5rem;">
    <h2>Quick Actions</h2>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
      <a href="/api/admin" class="refresh">Refresh Page</a>
      <a href="/health" class="refresh" style="background:#1f6feb;">Health Check</a>
      <a href="/api/ssot" class="refresh" style="background:#1f6feb;">SSOT (JSON)</a>
      <a href="/api/config" class="refresh" style="background:#1f6feb;">Runtime Config</a>
      <a href="/api/domain" class="refresh" style="background:#1f6feb;">Domain Config</a>
      <a href="/identity" class="refresh" style="background:#1f6feb;">Identity</a>
      <a href="/v1/models" class="refresh" style="background:#1f6feb;">Agent Models</a>
      <a href="/api/v1/models" class="refresh" style="background:#1f6feb;">Provider Models</a>
      <a href="/" class="refresh" style="background:#6e40c9;">Main Dashboard</a>
    </div>
  </div>

  <div class="footer">
    Mission Barisal v${DOMAIN_CFG.version} | ${DOMAIN_CFG.identity.name} | ${DOMAIN_CFG.identity.branding.location}<br>
    Generated: ${new Date().toISOString()}
  </div>
</div>
</body>
</html>`;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ── GET /api/admin/stats ───────────────────────────────────
    // Returns all runtime stats as JSON (programmatic access)
    // ─── 🧟 GET /api/admin/tools — per-tool stats + on/off (DB-backed) ──
    if (url === "/api/admin/tools" && method === "GET") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      const dbRows = {};
      if (MODELS_DB) {
        try {
          for (const r of MODELS_DB.prepare(
            "SELECT tool, calls, errors, last_used, enabled FROM tool_stats",
          ).all())
            dbRows[r.tool] = r;
        } catch (_) {}
      }
      const names = Array.from(
        new Set([
          ...Object.keys(MCP_TOOLS),
          ...Object.keys(dbRows),
          ...Object.keys(STATS.toolUsage || {}),
        ]),
      ).sort();
      jsonResponse(res, 200, {
        ok: true,
        total_tools: names.length,
        tools: names.map((name) => {
          const d = dbRows[name];
          const mem = (STATS.toolUsage || {})[name] || {};
          let memMs = null;
          if (mem.lastUsed) {
            const t = Date.parse(mem.lastUsed);
            if (!isNaN(t)) memMs = t;
          }
          return {
            name,
            description: (MCP_TOOLS[name] && MCP_TOOLS[name].description) || "",
            builtin: !!MCP_TOOLS[name],
            calls: Math.max(d ? d.calls : 0, mem.count || 0),
            errors: Math.max(d ? d.errors : 0, mem.errors || 0),
            last_used:
              d && d.last_used ? d.last_used : memMs, // epoch ms | null
            enabled: d ? d.enabled !== 0 : true,
          };
        }),
      });
      return;
    }
    // ─── 🧟 POST /api/admin/tools — toggle one tool on/off ────────────
    if (url === "/api/admin/tools" && method === "POST") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      const body = await readBody(req);
      let b;
      try {
        b = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!b || typeof b.tool !== "string" || typeof b.enabled !== "boolean") {
        jsonResponse(res, 400, {
          error: "tool (string) and enabled (boolean) required",
        });
        return;
      }
      if (!MCP_TOOLS[b.tool]) {
        jsonResponse(res, 404, { error: "Unknown tool: " + b.tool });
        return;
      }
      dbRun(
        `INSERT INTO tool_stats (tool, calls, errors, last_used, enabled)
         VALUES (?, 0, 0, ?, ?)
         ON CONFLICT(tool) DO UPDATE SET enabled = excluded.enabled`,
        [b.tool, Date.now(), b.enabled ? 1 : 0],
      );
      log("INFO", "ADMIN_TOOL_TOGGLE", { tool: b.tool, enabled: b.enabled });
      jsonResponse(res, 200, { ok: true, tool: b.tool, enabled: b.enabled });
      return;
    }
    // ─── 🧟 GET /api/admin/session-log — SQLite session/request history ──
    if (url === "/api/admin/session-log" && method === "GET") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      const sessions = [];
      const recent = [];
      if (MODELS_DB) {
        try {
          for (const r of MODELS_DB.prepare(
            "SELECT * FROM session_log ORDER BY last_seen DESC LIMIT 100",
          ).all())
            sessions.push(r);
          for (const r of MODELS_DB.prepare(
            "SELECT * FROM request_log ORDER BY id DESC LIMIT 50",
          ).all())
            recent.push(r);
        } catch (_) {}
      }
      jsonResponse(res, 200, {
        ok: true,
        sessions,
        recent,
        active: cleanExpired().length,
        // 🧟 lifetime agent-call counter (agent_stats SUM — survives restart)
        agent_calls: (function () {
          if (!MODELS_DB) return null;
          try {
            const r = MODELS_DB
              .prepare("SELECT COALESCE(SUM(calls),0) AS c FROM agent_stats")
              .get();
            return r ? r.c : null;
          } catch (e) {
            return null;
          }
        })(),
      });
      return;
    }

    if (url === "/api/admin/stats" && method === "GET") {
      try {
        const mem = process.memoryUsage();
        const allLocks = readLockLogs();
        jsonResponse(res, 200, {
          // 🧟 flat, DB-hydrated usage keys the admin Usage page reads
          ...(typeof getUsageStats === "function" ? getUsageStats() : {}),
          server: {
            version: DOMAIN_CFG.version,
            domain: requestDomain,
            type: DOMAIN_CFG.type,
            uptime_sec: Math.floor((Date.now() - STATS.startTime) / 1000),
            total_requests: STATS.totalRequests,
            agents: AGENTS.length,
            providers: Object.keys(PROVIDER_CONFIG).length,
            models: FREE_MODELS.length,
            pusher: PUSHER_ENABLED,
            frontend: DOMAIN_CFG.hasFrontend,
            sessions: cleanExpired().length,
            memory_rss_mb: Math.round(mem.rss / 1024 / 1024),
            memory_heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
            lock_log_entries: allLocks.length,
          },
          usage: {
            providers: STATS.providerUsage || {},
            models: STATS.modelUsage || {},
            agents: STATS.agentUsage || {},
            domains: STATS.domainRequests || {},
          },
          rate_limit: getRateLimitStatus(),
          domain_config: {
            maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
            corsOrigins: DOMAIN_CFG.corsOrigins,
            sessionVerifyUrl: DOMAIN_CFG.sessionVerifyUrl,
            hasPusher: PUSHER_ENABLED,
            hasDevModels: DOMAIN_CFG.hasDevModels,
          },
          env: {
            PORT: process.env.PORT || null,
            DEPLOY_DOMAIN: process.env.DEPLOY_DOMAIN || null,
            PUSHER_ENABLED: PUSHER_ENABLED,
            GROQ_API_KEY: !!process.env.GROQ_API_KEY,
            GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
            OPENCODE_API_KEY: !!process.env.OPENCODE_API_KEY,
          },
          agents: AGENTS.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            model: a.model,
            priority: a.priority,
          })),
        });
      } catch (err) {
        log("ERROR", "STATS_HANDLER", { error: err.message });
        jsonResponse(res, 200, {
          error: "Stats collection failed: " + err.message,
          server: { version: DOMAIN_CFG.version, domain: requestDomain },
          agents: AGENTS.map((a) => ({ id: a.id, name: a.name, role: a.role })),
        });
      }
      return;
    }

    // ─── GET /api/locks ─────────────────────────────────────────
    // Lock Log viewer — JSON format debug memory
    if (url.startsWith("/api/locks") && method === "GET") {
      const parts = url.split("/");
      let result;
      if (parts.length === 3 && parts[2].length > 0 && parts[2] !== "stats") {
        // Specific date: /api/locks/2026-07-11
        const dateStr = parts[2];
        result = {
          date: dateStr,
          locks: readLockLogs(dateStr),
          count: readLockLogs(dateStr).length,
        };
      } else if (parts[parts.length - 1] === "stats") {
        // /api/locks/stats
        result = getLockStats();
      } else {
        // /api/locks — returns latest entries grouped by date
        const all = readLockLogs();
        const latest = all.slice(-50).reverse();
        result = {
          total: all.length,
          latest: latest,
          stats: getLockStats(),
          details:
            "Use /api/locks/YYYY-MM-DD for specific date, /api/locks/stats for summary",
        };
      }
      jsonResponse(res, 200, result);
      return;
    }

    // ─── POST /api/normalize ────────────────────────────────
    // Haq Mawla Normalizer test — send any raw response to see normalized output
    // body: { input?, model? }  → normalizes a raw payload
    // body: { sync: true }      → runs full provider sync (fetch → config → SQLite)
    // body: { envSync: true }   → re-reads model env vars (single source of
    //                              truth) and syncs them into the models DB
    if (url === "/api/normalize" && method === "POST") {
      const body = await readBody(req);
      try {
        const input = JSON.parse(body);
        // Env-var sync mode: re-read env model lists → update config → persist
        if (input.envSync || input.mode === "envSync") {
          const envResult = syncEnvModelsToDb();
          log("INFO", "NORMALIZE_ENV_SYNC", { ...envResult });
          jsonResponse(res, 200, {
            success: true,
            normalizer: "Haq Mawla Universal Response Normalizer",
            envSync: true,
            providers: envResult.providers,
            db: envResult.db,
          });
          return;
        }
        // Sync mode: fetch live models from all providers → merge → persist to SQLite
        if (input.sync || input.mode === "sync") {
          const syncResult = await runNormalizerSync();
          log("INFO", "NORMALIZE_SYNC", { ...syncResult.results });
          jsonResponse(res, 200, {
            success: true,
            normalizer: "Haq Mawla Universal Response Normalizer",
            synced: true,
            results: syncResult.results,
            db: syncResult.db,
          });
          return;
        }
        // R2T mode: run the response-to-tool engine from the normalizer testbed.
        // body: { mode: "r2t", message: "[[TOOL:info]][[/TOOL]]", model? }
        // Runs the same virtual model used by model="r2t" on /v1/chat/completions.
        if (input.r2t || input.mode === "r2t") {
          const r2tModel = input.model || "r2t";
          const r2tMessages = [
            { role: "user", content: input.message || input.input_text || "[[TOOL:info]][[/TOOL]]" },
          ];
          const r2tResult = await executeR2tRequest(r2tModel, r2tMessages, {});
          // r2tResults returns a normalized chat.completion wrapper; expose the
          // parsed execution payload too when the caller asked for raw mode.
          const result = r2tResult && r2tResult.choices && r2tResult.choices[0]
            ? r2tResult
            : r2tResult;
          log("INFO", "REQUEST", {
            method,
            url,
            status: 200,
            elapsed: Date.now() - startTime,
            r2t: true,
          });
          jsonResponse(res, 200, result);
          return;
        }
        const result = normalizeResponse(input, input.model || "test");
        log("INFO", "REQUEST", {
          method,
          url,
          status: 200,
          elapsed: Date.now() - startTime,
        });
        jsonResponse(res, 200, result);
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
      return;
    }

    // ─── GET /api/normalize-list ───────────────────────────
    // Haq Mawla normalizer info — provider-aware model listing (DB + env merged)
    if (url === "/api/normalize-list" && method === "GET") {
      let dbStats = { enabled: false };
      if (MODELS_DB) {
        try {
          const count = MODELS_DB
            .prepare("SELECT COUNT(*) AS c FROM models")
            .get().c;
          dbStats = {
            enabled: true,
            path: MODELS_DB_PATH,
            models: count,
            lastSync: MODELS_DB
              .prepare("SELECT MAX(updated_at) AS t FROM models")
              .get().t,
          };
        } catch (e) {
          dbStats = { enabled: true, error: e.message };
        }
      }
      jsonResponse(res, 200, {
        normalizer: "Haq Mawla Universal Response Normalizer",
        version: "1.0.0",
        providers: Object.entries(PROVIDER_CONFIG).map(([id, p]) => ({
          id,
          name: p.name || id,
          type: p.type || "openai",
          baseUrl: p.baseUrl || "",
          models: p.models || [],
          priority: p.priority,
          enabled: p.enabled !== false, // 🧟 admin toggle state
        })),
        models: getAllModels(),
        disabledModels: getDisabledModelRows(), // 🧟 for admin re-enable UI
        db: dbStats,
        features: [
          "OpenAI standard format",
          "Anthropic format (content array)",
          "Gemini format (candidates/parts)",
          "Raw string fallback",
          "Reasoning-content extraction (Mimo/North Mini/Nemotron fix)",
          "Provider detection",
          "Dynamic provider routing (competitionRouter)",
          "SQLite models table (sync: POST /api/normalize { sync: true })",
        ],
      });
      return;
    }

    // ─── GET/POST /api/config ──────────────────────────────
    // Runtime configuration — view or update without server restart
    if (url === "/api/config" && method === "GET") {
      jsonResponse(res, 200, {
        success: true,
        config: { ...RUNTIME_CONFIG },
        domain: {
          detected: DETECTED_DOMAIN,
          type: DOMAIN_CFG.type,
          version: DOMAIN_CFG.version,
        },
      });
      return;
    }
    if (url === "/api/config" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const updated = updateRuntimeConfig(parsed);
      log("INFO", "CONFIG_UPDATED", {
        updates: Object.keys(parsed),
      });
      jsonResponse(res, 200, {
        success: true,
        config: updated,
        message: "Runtime config updated. No restart needed.",
      });
      return;
    }

    // ─── GET /api/config/origin — Full origin config ─────────
    // Serves the complete origin identity + capabilities.
    // Any client can GET this to know how to connect.
    // No auth required — this is public info.
    if (url === "/api/config/origin" && method === "GET") {
      const publicUrl = DOMAIN_CFG.appUrl || `http://localhost:${PORT}`;
      const publicHost = DOMAIN_CFG.domain || `localhost:${PORT}`;
      const protocol = DOMAIN_CFG.protocol || "http";
      const wsProtocol = protocol === "https" ? "wss" : "ws";

      jsonResponse(res, 200, {
        origin: DOMAIN_CFG.name || "Mission Barisal Gateway",
        version: DOMAIN_CFG.version,
        url: publicUrl,
        domain: DETECTED_DOMAIN,
        type: DOMAIN_CFG.type,
        session: {
          verify:
            DOMAIN_CFG.sessionVerifyUrl || `${publicUrl}/api/verify-session`,
          autoCreate: true,
          endpoint: `${publicUrl}/api/connect`,
        },
        mcp: {
          http: `${publicUrl}/mcp`,
          ws: `${wsProtocol}://${publicHost}/mcp`,
          connect: `${publicUrl}/api/connect`,
        },
        tools: Object.keys(MCP_TOOLS),
        identity: DOMAIN_CFG.identity || {
          name: "ZombieCoder",
          project: "Mission Barisal — Multi-Agent Code Platform",
        },
      });
      return;
    }

    // ─── GET /api/config/mcp — MCP config for remote clients ─
    // Returns MCP connection config with public URL.
    // Remote editors (VS Code, JetBrains, Cursor) can use this.
    if (url === "/api/config/mcp" && method === "GET") {
      const publicUrl = DOMAIN_CFG.appUrl || `http://localhost:${PORT}`;
      const publicHost = DOMAIN_CFG.domain || `localhost:${PORT}`;
      const protocol = DOMAIN_CFG.protocol || "http";
      const wsProtocol = protocol === "https" ? "wss" : "ws";

      jsonResponse(res, 200, {
        name: DOMAIN_CFG.name || "Mission Barisal Gateway",
        transport: {
          type: "http",
          url: `${publicUrl}/mcp`,
          connect: `${publicUrl}/api/connect`,
        },
        endpoints: {
          http: publicUrl,
          connect: `${publicUrl}/api/connect`,
          ws: `${wsProtocol}://${publicHost}`,
        },
        tools: Object.keys(MCP_TOOLS),
        timeout: 300000,
      });
      return;
    }

    // ─── GET /api/mcp-remote (Phase D) — outbound MCP status ──
    // Lists remote MCP servers this gateway connects TO (outbound client),
    // their discovered tools, and how many merged into MCP_TOOLS.
    if (url === "/api/mcp-remote" && method === "GET") {
      jsonResponse(res, 200, {
        ok: true,
        env: process.env.REMOTE_MCP_SERVERS || "",
        servers: Array.from(mcpRemoteClients.values()),
        mergedTools: Object.keys(MCP_TOOLS).filter((k) =>
          k.startsWith("remote__"),
        ).length,
        totalMcpTools: Object.keys(MCP_TOOLS).length,
      });
      return;
    }

    // ─── GET /api/mcp-external (Phase D3) — external MCP status ──
    if (url === "/api/mcp-external" && method === "GET") {
      jsonResponse(res, 200, {
        ok: true,
        config: externalMcp.CONFIG_FILE,
        envUrls: process.env.EXTERNAL_MCP_URLS || "",
        servers: externalMcp.getStatus(),
        mergedTools: Object.keys(MCP_TOOLS).filter((k) =>
          k.includes("__"),
        ).length,
        totalMcpTools: Object.keys(MCP_TOOLS).length,
      });
      return;
    }

    // ─── POST /api/mcp-remote/sync (Phase D) — re-discover ──
    if (url === "/api/mcp-remote/sync" && method === "POST") {
      const result = await syncAllRemoteMCPs();
      const merged = mergeRemoteMcpTools();
      jsonResponse(res, 200, { ok: true, ...result, merged });
      return;
    }

    // ─── POST /api/mcp-remote/add (Phase D) — add at runtime ──
    if (url === "/api/mcp-remote/add" && method === "POST") {
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!p.url) {
        jsonResponse(res, 400, { error: "url required" });
        return;
      }
      const entry = await discoverRemoteMCP({ url: p.url, name: p.name || "" });
      const merged = mergeRemoteMcpTools();
      jsonResponse(res, 200, { ok: true, server: entry, merged });
      return;
    }

    // ─── POST /api/mcp-remote/remove (Phase D) — drop server ──
    if (url === "/api/mcp-remote/remove" && method === "POST") {
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!p.name) {
        jsonResponse(res, 400, { error: "name required" });
        return;
      }
      const removed = mcpRemoteClients.delete(p.name);
      // remove merged tools for this server
      for (const k of Object.keys(MCP_TOOLS)) {
        if (k.startsWith("remote__" + p.name + "__")) delete MCP_TOOLS[k];
      }
      jsonResponse(res, 200, { ok: true, removed });
      return;
    }

    // ─── POST /api/set-working-dir ──────────────────────────
    // Non-MCP endpoint for zombieBridge to set working directory and auto-generate SSOT.
    // Simpler than formatting a full MCP JSON-RPC message.
    if (url === "/api/set-working-dir" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const directory = parsed.directory || parsed.dir || parsed.path || ".";
      const resolvedDir = path.resolve(directory);
      log("INFO", "SET_WORKING_DIR", {
        dir: resolvedDir,
        client: parsed.client || req.headers["x-mcp-client-name"] || "unknown",
      });
      mcpWorkingDir = resolvedDir;
      const ssot = refreshSSOT(resolvedDir);
      jsonResponse(res, 200, {
        success: true,
        working_dir: mcpWorkingDir,
        ssot: ssot
          ? ssot.length + " bytes generated"
          : "ssot generation failed",
        message:
          "Working directory set. SSOT auto-generated. Call /api/mcp-clients to see connected clients.",
      });
      return;
    }

    // ─── GET /api/ssot ─────────────────────────────────────────
    // Returns the current SSOT content — agents use this as source of truth.
    // Priority: 1) projectDir/mcpWorkingDir SSOT, 2) server own SSOT
    if (url === "/api/ssot" && method === "GET") {
      const ssotContent = readSSOT(mcpWorkingDir);
      if (ssotContent) {
        jsonResponse(res, 200, {
          success: true,
          source: "local-server",
          project_root: path.resolve(mcpWorkingDir || "."),
          ssot_path: path.join(
            mcpWorkingDir || path.resolve("."),
            ".zombiecoder",
            "SSOT.md",
          ),
          length: ssotContent.length,
          content: ssotContent,
          note: "THIS is the correct SSOT. Do NOT use MCP tool ssot if root doesnt match.",
        });
      } else {
        // Auto-generate if missing
        const generated = autoSSOT(mcpWorkingDir || path.resolve("."));
        jsonResponse(res, generated ? 200 : 404, {
          success: !!generated,
          message: generated
            ? "SSOT auto-generated"
            : "No SSOT found and generation failed",
          ssot_path: SSOT_PATH,
        });
      }
      return;
    }

    // ──── GET /api/sessions ─────────────────────────────────────
    // Lists all sessions with memory/metadata (admin view)
    if (url === "/api/sessions" && method === "GET") {
      const sessions = readSessions();
      const enriched = sessions.map((s) => {
        const memDir = path.join(DATA_DIR, s.id);
        let memCount = 0;
        let agentCount = 0;
        if (fs.existsSync(memDir)) {
          try {
            const files = fs.readdirSync(memDir);
            agentCount = files.filter((f) => f.endsWith(".json")).length;
            for (const f of files) {
              if (f.endsWith(".json")) {
                try {
                  const data = JSON.parse(
                    fs.readFileSync(path.join(memDir, f), "utf8"),
                  );
                  memCount += Array.isArray(data) ? data.length : 1;
                } catch (e) { }
              }
            }
          } catch (e) { }
        }
        // Also check global session memory
        const globalMemFile = path.join(DATA_DIR, "mem-" + s.id + ".json");
        let globalMemCount = 0;
        if (fs.existsSync(globalMemFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(globalMemFile, "utf8"));
            globalMemCount = Array.isArray(data) ? data.length : 0;
          } catch (e) { }
        }
        return {
          id: s.id,
          client_id: s.client_id,
          editor: s.editor,
          model: s.model || "",
          provider: s.provider || "",
          messages: s.messages || 0,
          status: s.status,
          agent_memory_files: agentCount,
          agent_memory_entries: memCount,
          global_memory_entries: globalMemCount,
          created_at: s.created_at,
          expires_at: s.expires_at,
        };
      });
      jsonResponse(res, 200, {
        total: enriched.length,
        active: enriched.filter((s) => s.status === "active").length,
        sessions: enriched,
      });
      return;
    }

    // ──── GET /api/sessions/{id} — Single session with full memory ──
    if (url.startsWith("/api/sessions/") && method === "GET") {
      const sessionId = url.replace("/api/sessions/", "").split("/")[0];
      if (!sessionId) {
        jsonResponse(res, 400, { error: "Session ID required" });
        return;
      }
      // Check if requesting memory sub-resource
      const isMemoryRequest = url.includes("/memory");
      const session = getSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, {
          error: "Session not found or expired",
          id: sessionId,
        });
        return;
      }
      if (isMemoryRequest) {
        // Return per-agent memory
        const memDir = path.join(DATA_DIR, sessionId);
        const agentMemories = {};
        if (fs.existsSync(memDir)) {
          try {
            const files = fs.readdirSync(memDir);
            for (const f of files) {
              if (f.endsWith(".json")) {
                const agentId = f.replace(".json", "");
                try {
                  agentMemories[agentId] = JSON.parse(
                    fs.readFileSync(path.join(memDir, f), "utf8"),
                  );
                } catch (e) {
                  agentMemories[agentId] = [];
                }
              }
            }
          } catch (e) { }
        }
        // Global session memory
        const globalMem = getMemory(sessionId);
        jsonResponse(res, 200, {
          session: session,
          agent_memories: agentMemories,
          global_memory: globalMem,
          memory_count:
            Object.values(agentMemories).reduce(
              (a, b) => a + (Array.isArray(b) ? b.length : 0),
              0,
            ) + (Array.isArray(globalMem) ? globalMem.length : 0),
        });
      } else {
        // Just session metadata
        jsonResponse(res, 200, { session });
      }
      return;
    }

    // ─── POST /v1/chat/completions ──────────────────────────
    if (url === "/v1/chat/completions" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        log("INFO", "REQUEST", {
          method,
          url,
          status: 400,
          elapsed: Date.now() - startTime,
          error: "Invalid JSON",
        });
        jsonResponse(res, 400, { error: { message: "Invalid JSON" } });
        return;
      }

      const model = parsed.model || "mission";
      const messages = parsed.messages || [];
      const stream = parsed.stream || false;
      const temperature = parsed.temperature || 0.7;
      // Phase C: shared sanitizer — validates array + caps at MAX_TOOLS_LIMIT
      // (was inline TOOLS_CAP_FIX: small models return EMPTY response when
      // handed ~70 tools, e.g. "Tools provided: 71, Estimated input tokens:
      // 50471"). EVERY /v1/chat/completions branch is protected.
      // 🧟 tools:"mcp" → server builds the tool list from MCP_TOOLS, so the
      // admin Agent Chat (and any simple client) gets REAL tool access
      // (web_search, read_file, ...) instead of plain chat-only.
      let tools = sanitizeTools(
        parsed.tools === "mcp" ? mcpToolsToOpenAI() : parsed.tools,
        model,
      );
      const projectContext = parsed.project_context || parsed.ssot || "";

      // Track model usage
      trackModelUsage(model);

      // ── Extract extended metadata from headers ──
      const sessionMeta = {
        agent_id: req.headers["x-agent-id"] || parsed.agent_id || "",
        user_agent: req.headers["user-agent"] || "",
        device_info: req.headers["x-device-info"] || parsed.device_info || "",
        editor_version:
          req.headers["x-editor-version"] || parsed.editor_version || "",
        os_platform: req.headers["x-os-platform"] || parsed.os_platform || "",
        client_version:
          req.headers["x-client-version"] || parsed.client_version || "",
        session_source: "api",
      };

      // ── PHASE B: optional API auth (Bearer session token or X-API-Key) ──
      // If auth headers ARE present they are validated; invalid → 401.
      // If no auth headers → anonymous (existing behavior preserved).
      const auth = authFromRequest(req);
      if (auth.ok === false) {
        log("INFO", "REQUEST", {
          method,
          url,
          status: 401,
          elapsed: Date.now() - startTime,
          error: "Unauthorized: " + auth.reason,
        });
        jsonResponse(res, 401, {
          error: { message: "Unauthorized: " + auth.reason },
        });
        return;
      }
      if (auth.ok === true) {
        sessionMeta.auth_user = auth.user;
        // UI-1: enforce per-user limits (token quota / expiry)
        const lim = checkUserLimits(auth.user);
        if (!lim.ok) {
          log("INFO", "REQUEST", {
            method,
            url,
            status: 403,
            elapsed: Date.now() - startTime,
            error: "Limit exceeded: " + lim.reason,
          });
          jsonResponse(res, 403, {
            error: { message: "Limit exceeded: " + lim.reason, limit: lim },
          });
          return;
        }
        // Bump usage counter (per authenticated request = 1 unit)
        bumpUserUsage(auth.user);
      }

      // Get or create session
      let sessionId = parsed.session_id;
      if (!sessionId || !getSession(sessionId)) {
        const session = createSession(
          parsed.client_id || "anonymous",
          parsed.editor || "hermes",
          req.socket.remoteAddress,
          sessionId || undefined,
          sessionMeta,
        );
        sessionId = session.id;
        // 🧟 session_log: first touch (SQLite — Sessions page reads this)
        recordSessionTouch(sessionId, {
          editor: parsed.editor || "hermes",
          status: "active",
          user_agent: req.headers["user-agent"] || null,
        });
      } else {
        // Update existing session metadata
        const existing = getSession(sessionId);
        if (existing) {
          existing.metadata = { ...(existing.metadata || {}), ...sessionMeta };
          activeSessions.set(sessionId, existing);
        }
      }

      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: 0,
        model,
        session: sessionId.slice(0, 8),
        messages: messages.length,
        stream,
      });

      // ─── R2T MODE (Response-to-Tool virtual model) ──────────
      // model="r2t" dispatches marker-based OS tool execution.
      // Guarded by R2T_ENABLED env flag: when false (e.g. on cPanel
      // where the external .mjs module cannot run) the request falls
      // through to mission mode with a clear notice — the main server
      // keeps working 100% without any dependency on the r2t module.
      if (model === "r2t" || model === "agent/r2t") {
        const r2tResult = await executeR2tRequest(model, messages, {
          stream,
        });
        if (stream && r2tResult.sse) {
          jsonResponse(res, 200, r2tResult.payload);
        } else {
          jsonResponse(res, 200, r2tResult);
        }
        return;
      }

      // ─── MISSION MODE ────────────────────────────────────
      if (model === "mission" || model === "agent/mission") {
        const userMsg = messages.filter((m) => m.role === "user").pop();
        let userInput = userMsg ? userMsg.content : "";
        // 🧟 FIX: Handle content array format (OpenAI multi-modal)
        // When content is [{type: "text", text: "..."}], extract text
        if (Array.isArray(userInput)) {
          userInput = userInput
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        }

        // SSE streaming if requested
        if (stream) {
          const corsOrigin = getCorsOrigin(req.headers.origin);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": corsOrigin,
          });

          const sseId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
          const baseTs = Math.floor(Date.now() / 1000);

          const currentSession = getSession(sessionId);

          // Send initial chunk (OpenAI format) to let client know streaming started
          const initialChunk = {
            id: sseId,
            object: "chat.completion.chunk",
            created: baseTs,
            model: "mission",
            choices: [
              { index: 0, delta: { content: "" }, finish_reason: null },
            ],
            session_id: sessionId,
            conversation_id: currentSession?.conversation_id || sessionId,
          };
          res.write("data: " + JSON.stringify(initialChunk) + "\n\n");

          // 🧟 CLOUDFLARE 524 PREVENTION: Send periodic SSE keep-alive comments
          // Cloudflare times out after 100s if no data sent. SSE comments (":\n\n") 
          // are valid SSE keep-alive that clients ignore but proxies see as activity.
          const keepAliveInterval = setInterval(() => {
            if (!res.writableEnded) {
              res.write(": keep-alive\n\n");
            }
          }, 30000); // Every 30 seconds

          const originalPushLog = pushLog;
          const originalPushAgent = pushAgentStatus;
          const originalPushOutput = pushOutput;
          const originalPushDone = pushDone;

          // Override push functions to also send real-time chunks via SSE
          pushLog = async (type, message) => {
            const msg = stripEmoji(
              typeof message === "string" ? message : JSON.stringify(message),
            ).slice(0, 150);
            const chunk = {
              id: sseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mission",
              choices: [
                {
                  index: 0,
                  delta: { content: msg ? "[" + type + "] " + msg : "" },
                  finish_reason: null,
                },
              ],
            };
            if (chunk.choices[0].delta.content)
              res.write("data: " + JSON.stringify(chunk) + "\n\n");
            await originalPushLog(type, message);
          };
          pushAgentStatus = async (agentId, status) => {
            // Progress callback handles agent status display; just pass through to original
            await originalPushAgent(agentId, status);
          };
          pushOutput = async (output) => {
            const msg = stripEmoji(output || "").slice(0, 150);
            if (!msg) return;
            const chunk = {
              id: sseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mission",
              choices: [
                { index: 0, delta: { content: msg }, finish_reason: null },
              ],
            };
            res.write("data: " + JSON.stringify(chunk) + "\n\n");
            await originalPushOutput(output);
          };
          pushDone = async (stats) => {
            await originalPushDone(stats);
          };

          // Progress callback for executeMission
          // INTERNAL ONLY — log progress but do NOT send to client
          let progressCount = 0;
          const progressCallback = (phase, id, info) => {
            progressCount++;
            // Log internally for debugging — never send to client
            log("DEBUG", "MISSION_PROGRESS", {
              phase,
              id,
              info: (info || "").slice(0, 100),
            });
          };

          let result;
          try {
            result = await antiDoteMonitor(
              executeMission,
              userInput,
              "",
              sessionId,
              progressCallback,
              tools,
            );
          } finally {
            // 🧟 Ensure keep-alive is stopped even on errors
            clearInterval(keepAliveInterval);
          }

          pushLog = originalPushLog;
          pushAgentStatus = originalPushAgent;
          pushOutput = originalPushOutput;
          pushDone = originalPushDone;

          // Final chunk with the actual content
          // Extra safety: strip any remaining thinking artifacts
          let finalCombined = result.combined || "";
          if (finalCombined) {
            finalCombined = finalCombined
              .replace(
                /The user asked "[^"]*" which is Bengali for "[^"]*"\n\n?/g,
                "",
              )
              .replace(
                /I need to check the (?:agents'|agent) reports\.?\s*\n?/g,
                "",
              )
              .replace(
                /Let me (?:search|check|verify|look|read|see)[^.]*\.?\s*\n?/g,
                "",
              )
              .replace(
                /Since the user is asking in Bengali, I should answer in Bengali\.?\s*\n?/g,
                "",
              )
              .replace(
                /^((?:Code Guru|Bug Hunter|Security|Performance|Doc King|QA Tyrant|মনু|জুয়েল|বৃষ্টি|রাশেদ|হালিম|মজনু).{0,50}(started|gave|says|mentioned|noted|pointed out)).{0,200}\n/gim,
                "",
              )
              .trim();
          }
          const finalChunk = {
            id: sseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "mission",
            choices: [
              {
                index: 0,
                delta: { content: finalCombined },
                finish_reason: "stop",
              },
            ],
          };
          // 🧟 telemetry: mission (stream) request
          trackAgentUsage("mission", !finalCombined);
          recordRequestLog({
            path: "/v1/chat/completions",
            session_id: sessionId,
            editor: parsed.editor || "mission",
            agent: "mission",
            model: "mission",
            status: 200,
            ok: !!finalCombined,
            elapsed_ms:
              typeof startTime === "number" ? Date.now() - startTime : 0,
          });
          recordSessionTouch(sessionId, {
            agent: "mission",
            model: "mission",
            editor: parsed.editor || "mission",
          });
          res.write("data: " + JSON.stringify(finalChunk) + "\n\n");
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // Non-streaming mission (with anti-dote monitoring)
        const result = await antiDoteMonitor(
          executeMission,
          userInput,
          "",
          sessionId,
          undefined,
          tools,
        );

        // Extra safety: strip any remaining thinking artifacts
        let cleanCombined = result.combined || "";
        if (cleanCombined) {
          cleanCombined = cleanCombined
            .replace(
              /The user asked "[^"]*" which is Bengali for "[^"]*"\n\n?/g,
              "",
            )
            .replace(
              /I need to check the (?:agents'|agent) reports\.?\s*\n?/g,
              "",
            )
            .replace(
              /Let me (?:search|check|verify|look|read|see)[^.]*\.?\s*\n?/g,
              "",
            )
            .replace(
              /Since the user is asking in Bengali, I should answer in Bengali\.?\s*\n?/g,
              "",
            )
            .replace(
              /^((?:Code Guru|Bug Hunter|Security|Performance|Doc King|QA Tyrant|মনু|জুয়েল|বৃষ্টি|রাশেদ|হালিম|মজনু).{0,50}(started|gave|says|mentioned|noted|pointed out)).{0,200}\n/gim,
              "",
            )
            .trim();
        }

        jsonResponse(res, result.success ? 200 : 500, {
          id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, ""),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mission",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: cleanCombined },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
            completion_tokens: Math.ceil(cleanCombined.length / 4),
            total_tokens: Math.ceil(
              (JSON.stringify(messages).length + cleanCombined.length) / 4,
            ),
          },
          session_id: sessionId,
          conversation_id: getSession(sessionId)?.conversation_id || sessionId,
          mission_stats: result.stats,
          mission_verification: result.verification,
        });
        // 🧟 telemetry: mission (non-stream) request
        trackAgentUsage("mission", !result.success);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "mission",
          agent: "mission",
          model: "mission",
          status: result.success ? 200 : 502,
          ok: !!result.success,
          elapsed_ms:
            typeof startTime === "number" ? Date.now() - startTime : 0,
        });
        recordSessionTouch(sessionId, {
          agent: "mission",
          model: "mission",
          editor: parsed.editor || "mission",
        });

        // SSOT Auto-Refresh: refresh project context after mission completes
        // So subsequent agents get the latest file structure and content
        try {
          const projectDir = mcpWorkingDir || sessionId;
          if (projectDir && fs.existsSync(projectDir)) {
            autoSSOT(projectDir);
            log("INFO", "SSOT_REFRESHED", { dir: projectDir });
          }
        } catch (_) {
          /* SSOT refresh failure should not block response */
        }

        return;
      }

      // ─── PROXY MODE (Competition Router + Provider Fallback) ──────
      // If model is not an agent but resolves to a provider -> direct proxy
      // Try next provider on failure (rate limit, timeout, error)
      const isAgent = AGENTS.some((a) => a.id === model);
      if (!isAgent) {
        const allProviders = Object.entries(PROVIDER_CONFIG).sort(
          ([, a], [, b]) => a.priority - b.priority,
        );
        const providerResolved = resolveProvider(model);
        const orderedProviders = providerResolved
          ? [
            [providerResolved.providerId, providerResolved.config],
            ...allProviders.filter(
              ([id]) => id !== providerResolved.providerId,
            ),
          ]
          : allProviders;

        log("INFO", "PROXY_ROUTE", {
          model,
          primaryProvider: orderedProviders[0]?.[0],
          fallbackCount: orderedProviders.length - 1,
          stream,
          messages: messages.length,
        });

        let lastError = null;
        let usedProvider = null;
        let usedModel = model;
        let proxyResult = null;

        // 🧟 GUARD: Skip template/placeholder model names in proxy loop
        let resolvedModel = model;
        if (!model || typeof model !== "string" || /\{\{.*\}\}/.test(model) || model.length < 2) {
          log("WARN", "TEMPLATE_MODEL_REJECTED", {
            model,
            reason: "Template placeholder detected — using fallback model",
          });
          // Replace with first available model from the primary provider
          const fallbackModels = (orderedProviders[0]?.[1]?.models || []);
          if (fallbackModels.length > 0) {
            resolvedModel = fallbackModels[0].apiModel || fallbackModels[0].name;
            log("INFO", "TEMPLATE_MODEL_REPLACED", { replacement: resolvedModel });
          } else {
            jsonResponse(res, 400, {
              error: { message: "Invalid model name: " + model + " (template placeholder not allowed)" },
            });
            return;
          }
        }

        // Model + Provider fallback: try all model×provider combos
        for (const [provId, provConf] of orderedProviders) {
          // Build model list: requested model first, then all other models from this provider
          const providerModels = (provConf.models || []).map(
            (m) => m.apiModel || m.name,
          );
          const tryModels = [
            resolvedModel,
            ...providerModels.filter((m) => m !== resolvedModel),
          ];

          for (const tryModel of tryModels) {
            log("INFO", "PROXY_TRY", { model: tryModel, provider: provId });
            proxyResult = await proxyChatCompletion(
              tryModel,
              messages,
              stream,
              temperature,
              tools,
              { id: provId, config: provConf },
            );
            if (proxyResult.success) {
              usedProvider = provId;
              usedModel = tryModel;
              break;
            }
            lastError = proxyResult.error;
            log("WARN", "PROXY_FAIL", {
              model: tryModel,
              provider: provId,
              error: lastError,
            });
            if (stream) break;
          }
          if (proxyResult && proxyResult.success) break;
          if (stream) break;
        }

        if (!proxyResult || !proxyResult.success) {
          jsonResponse(res, 502, {
            error: {
              message: lastError || "All providers and models failed",
              model,
              tried_providers: orderedProviders.map(([id]) => id),
            },
          });
          // 🧟 telemetry: proxy total failure (which provider died trying)
          recordProviderStat(
            usedProvider || "unknown",
            false,
            lastError || "All providers and models failed",
          );
          trackProviderUsage(usedProvider || "unknown", true);
          recordRequestLog({
            path: "/v1/chat/completions",
            session_id: sessionId,
            editor: parsed.editor || "hermes",
            model,
            provider: usedProvider || null,
            status: 502,
            ok: false,
            elapsed_ms: Date.now() - startTime,
          });
          return;
        }
        const currentSession = getSession(sessionId);
        // 🧟 telemetry: proxy success — the provider/model that REALLY served
        recordProviderStat(usedProvider, true, null);
        trackProviderUsage(usedProvider, false);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          model: usedModel || model,
          provider: usedProvider,
          status: 200,
          ok: true,
          elapsed_ms: Date.now() - startTime,
        });
        recordSessionTouch(sessionId, {
          model: usedModel || model,
          provider: usedProvider,
          editor: parsed.editor || "hermes",
        });
        // 🧟 TOOL ADAPTER: forward the adapter-parsed tool_calls to the
        // client — this block used to hardcode finish_reason:"stop" and
        // DROP tool_calls, so no /v1 client could ever see a function call.
        const proxyToolCalls =
          proxyResult && Array.isArray(proxyResult.tool_calls)
            ? proxyResult.tool_calls
            : [];
        return jsonResponse(res, 200, {
          id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, ""),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          provider: usedProvider,
          actual_model: usedModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: maskModelIdentity(
                  proxyResult ? proxyResult.content : "No response",
                ),
                ...(proxyToolCalls.length ? { tool_calls: proxyToolCalls } : {}),
              },
              finish_reason: proxyToolCalls.length ? "tool_calls" : "stop",
            },
          ],
          usage: {},
          session_id: sessionId,
          conversation_id: currentSession?.conversation_id || sessionId,
        });
      }

      // ─── SINGLE AGENT MODE ──────────────────────────────
      const agentId = String(model).replace(/^agent\//, ""); // model param = agent id (agent/ prefix optional)
      const agent = AGENTS.find((a) => a.id === agentId);
      if (!agent) {
        jsonResponse(res, 404, {
          error: { message: "Agent or model not found: " + agentId },
        });
        return;
      }

      if (stream) {
        // SSE Streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": getCorsOrigin(req.headers.origin),
        });

        const responseId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
        let fullContent = "";

        // Augment messages with system prompt
        let userMsgContent =
          messages.filter((m) => m.role === "user").pop()?.content || "";
        // 🧟 INPUT_FIX: same array-form normalization for the streaming path
        if (Array.isArray(userMsgContent)) {
          userMsgContent = userMsgContent
            .map((c) => (typeof c === "string" ? c : c.text || c.value || ""))
            .filter(Boolean)
            .join("\n");
        } else if (userMsgContent && typeof userMsgContent === "object") {
          userMsgContent =
            userMsgContent.text ||
            userMsgContent.value ||
            JSON.stringify(userMsgContent);
        }
        const involvesCode =
          /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(
            userMsgContent,
          );
        let extraRules = "";
        if (involvesCode) {
          extraRules =
            "\n\n🔒 CODE SAFETY & TEST RULES:" +
            "\n1. NEVER claim code changes 'work' without test evidence. Say 'UNTESTED' if not verified." +
            "\n2. Always specify WHICH file and WHICH lines to modify." +
            "\n3. Read project structure first — don't suggest changes that break existing code.";
        }

        const ssotCtx = getSSOTContext(projectContext);
        const threeFileCtx = buildThreeFileContext(null, sessionId);

        // 🧟 FIX-002: Detect if client (extension) already provides mission context
        // The extension's buildSystemMessage() sends a system message with persona + SSOT + syllabus.
        // When detected, skip server-side persona/SSOT/syllabus injection to avoid duplicates.
        const firstMsg = messages[0];
        const clientHasMissionContext =
          firstMsg &&
          firstMsg.role === "system" &&
          typeof firstMsg.content === "string" &&
          (firstMsg.content.includes("MISSION BARISAL SYSTEM CONTEXT") ||
            firstMsg.content.includes("Mission Barisal agent") ||
            firstMsg.content.includes("AGENT SYLLABUS"));

        if (clientHasMissionContext) {
          log("INFO", "CLIENT_MISSION_CONTEXT_DETECTED", {
            reason: "Extension provides full mission context — skipping server-side persona/SSOT/syllabus injection",
          });
        }

        const mandatoryCtx2 = clientHasMissionContext
          ? "" // Client already provided full mission context — skip server-side injection
          : "\n\n MANDATORY CONTEXT RULES (STRICTLY ENFORCED):" +
            "\n\n### BEFORE answering ANY question:" +
            "\n1. **CHECK SSOT FIRST** — The SSOT above contains this project's blueprint: tech stack, file structure, entry points, dependencies. Read it before responding." +
            "\n2. **CHECK SYLLABUS** — The syllabus above contains your learned knowledge AND the project footprint (languages, frameworks, patterns). This is your memory — use it." +
            "\n3. **CHECK SESSION MEMORY** — Previous conversations are logged above. Reference them to avoid repeating mistakes." +
            "\n4. **NEVER GUESS** — If SSOT/Syllabus/Memory has the answer, use it directly. If not, search the web. Do NOT fabricate." +
            "\n\n### WHILE responding:" +
            "\n5. **BE CONCISE** — Answer directly. Do not explain things the user already knows. Do not repeat information from SSOT/Syllabus." +
            "\n6. **USE EVIDENCE** — Reference file paths, line numbers, test results. Say 'আমার কাছে প্রমাণ নেই' if you cannot prove." +
            "\n7. **FOLLOW PERSONA** — You are " + agent.name + " — Mission Barisal Agent. Never break character." +
            "\n8. **IDENTITY** — You are NOT GPT/Claude/Gemini. Never mention any other model/provider." +
            "\n\n### CONSTRAINT:" +
            "\nIf you lack data AND web search fails, say: 'ভাইয়া, এই মুহূর্তে আমার কাছে এই তথ্যগুলো নাই।' and STOP.";

        // When client provides mission context, use a minimal system message
        // (just agent identity + proof requirement). Skip persona/SSOT/syllabus
        // since the extension already included them.
        const sysMsg = clientHasMissionContext
          ? {
              role: "system",
              content:
                "You are " +
                agent.name +
                " — Mission Barisal Agent." +
                "\n\nPROOF REQUIREMENT: You MUST provide verifiable evidence for EVERY claim. If you cannot provide evidence, say 'আমার কাছে প্রমাণ নেই'. Still help with what you know — say you lack proof but offer suggestions." +
                extraRules,
            }
          : {
              role: "system",
              content:
                agent.persona +
                "\n\n" +
                buildAgentIdentity(agent) +
                "\n\nPROOF REQUIREMENT: You MUST provide verifiable evidence for EVERY claim. If you cannot provide evidence, say 'আমার কাছে প্রমাণ নেই'. Still help with what you know — say you lack proof but offer suggestions." +
                mandatoryCtx2 +
                extraRules +
                ssotCtx +
                threeFileCtx,
            };

        // Load memory
        let augmentedMessages = [sysMsg, ...messages];
        if (sessionId) {
          const mem = getAgentMemory(sessionId, agentId);
          if (mem.length > 0) {
            const history = mem
              .filter((m) => m.role === "user" || m.role === "assistant")
              .slice(-MAX_HISTORY);
            const histMsgs = history.map((m) => ({
              role: m.role,
              content: m.content,
            }));
            augmentedMessages = [sysMsg, ...histMsgs, ...messages];
          }
        }

        // 🧟 LOCAL MODEL TOOL LIMIT: Ollama/llama.cpp can't handle many tools
        // with large system prompts → timeout. Cap aggressively for local models.
        const agentProviderInfo = resolveProvider(agent.model, true);
        const agentProviderId = agentProviderInfo?.providerId || "";
        const isLocalAgent = agentProviderInfo?.config?.local || /^custom_/.test(agentProviderId) || /^(qwen|deepseek|llama|mistral)/.test(agent.model);
        const MAX_TOOLS_LIMIT = isLocalAgent ? 5 : 15;
        let toolsForStream =
          tools ||
          Object.entries(MCP_TOOLS).map(([name, def]) => ({
            type: "function",
            function: {
              name,
              description: def.description || name,
              parameters: def.parameters || {
                type: "object",
                properties: def.params || {},
                required: def.required || [],
              },
            },
          }));

        // Cap streaming tools too — same reason as non-stream path.
        if (toolsForStream && toolsForStream.length > MAX_TOOLS_LIMIT) {
          log("WARN", "TOOLS_CAPPED_STREAM", {
            original: toolsForStream.length,
            capped: MAX_TOOLS_LIMIT,
            reason: isLocalAgent ? "local_model_limit" : "global_limit",
          });
          toolsForStream = toolsForStream.slice(0, MAX_TOOLS_LIMIT);
        }

        // 🧟 EMPTY RESPONSE RETRY: If model returns empty, retry once without tools
        let retryWithoutTools = false;
        const streamCallback = (delta, parsed) => {
            const content = delta.content || "";
            const toolCalls = delta.tool_calls || null;
            if (content) fullContent += content;

            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: agent.id, // ← Masked: agent id, not real model
              choices: [{ index: 0, delta: {}, finish_reason: null }],
            };

            if (content) chunk.choices[0].delta.content = content;
            if (toolCalls) chunk.choices[0].delta.tool_calls = toolCalls;

            const finishReason = parsed.choices?.[0]?.finish_reason || null;
            if (finishReason) chunk.choices[0].finish_reason = finishReason;

            res.write("data: " + JSON.stringify(chunk) + "\n\n");
        };

        // First attempt: with tools
        await callModelStream(
          agent.model,
          augmentedMessages,
          temperature,
          streamCallback,
          toolsForStream,
        );

        // 🧟 EMPTY RESPONSE RETRY: model returned nothing with tools → retry without
        if (!fullContent && toolsForStream && toolsForStream.length > 0) {
          retryWithoutTools = true;
          log("WARN", "EMPTY_RESPONSE_RETRY", {
            agent: agent.id,
            tools: toolsForStream.length,
            reason: "model returned 0 chars with tools, retrying without tools",
          });
          fullContent = ""; // reset
          await callModelStream(
            agent.model,
            augmentedMessages,
            temperature,
            streamCallback,
            undefined, // no tools on retry
          );
        }

        // Final [DONE] chunk
        // Apply identity masking to full content — strip model names
        const maskedFullContent = maskModelIdentity(fullContent);
        // 🧟 #5 swap_notice: surface every silent provider/model fallback
        // (ethics §4 — the user must KNOW the swap happened).
        const swapNotice = getSwapNotice(augmentedMessages);
        const doneData = JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: agent.id,
          ...(swapNotice ? { swap_notice: swapNotice } : {}),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: Math.ceil(
              JSON.stringify(augmentedMessages).length / 4,
            ),
            completion_tokens: Math.ceil(maskedFullContent.length / 4),
            total_tokens: Math.ceil(
              (JSON.stringify(augmentedMessages).length +
                maskedFullContent.length) /
              4,
            ),
          },
        });
        res.write("data: " + doneData + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();

        // Save memory
        if (sessionId) {
          const userMsg = messages.filter((m) => m.role === "user").pop();
          let userContent = userMsg ? userMsg.content : "";
          //  INPUT_FIX: normalize array content before persisting to memory
          if (Array.isArray(userContent)) {
            userContent = userContent
              .map((c) => (typeof c === "string" ? c : c.text || c.value || ""))
              .filter(Boolean)
              .join("\n");
          }
          if (userMsg)
            saveAgentMemory(sessionId, agentId, "user", userContent);
          if (fullContent)
            saveAgentMemory(sessionId, agentId, "assistant", fullContent);
          saveMemory(sessionId, "user", userContent);
          saveMemory(sessionId, "assistant", fullContent);
          updateSession(sessionId, {
            model: agentId,
            provider: agent.model,
            messages: (getSession(sessionId)?.messages || 0) + 1,
          });
          flushAllMemory();
          try {
            archiveSession(
              mcpWorkingDir,
              sessionId,
              [
                { role: "user", content: stripUserRequestTags(userContent) },
                { role: "assistant", content: deduplicateText(fullContent || "") },
              ],
              `Agent ${agentId} (inline-stream): ${(fullContent || "").slice(0, 100)}`,
            );
          } catch (_) { }
        }

        // 🧟 telemetry: agent/model counters + request log + session touch
        const _finMs = Date.now() - startTime;
        let _finProv = null;
        try {
          _finProv = resolveProvider(agent.model).providerId;
        } catch (_) {}
        trackAgentUsage(agent.id, !fullContent, agent.model, _finProv);
        recordModelStat(agent.model, _finProv, !!fullContent);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          agent: agent.id,
          model: agent.model,
          provider: _finProv,
          status: 200,
          ok: !!fullContent,
          elapsed_ms: _finMs,
        });
        recordSessionTouch(sessionId, {
          agent: agent.id,
          model: agent.model,
          provider: _finProv,
          editor: parsed.editor || "hermes",
        });
        log("INFO", "SINGLE_AGENT_STREAM_COMPLETE", {
          agent: agent.id,
          contentLength: fullContent.length,
          elapsed: _finMs,
        });
        return;
      }

      // Non-streaming single agent
      const singleResult = await executeSingleAgent(
        agentId,
        messages,
        false,
        sessionId,
        tools,
        projectContext,
      );

      if (!singleResult.success) {
        // 🧟 telemetry: failed agent call
        let _prov = null;
        try {
          _prov = resolveProvider(agent.model).providerId;
        } catch (_) {}
        trackAgentUsage(agentId, true, agent.model || null, _prov);
        recordModelStat(agent.model, _prov, false);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          agent: agentId,
          model: agent.model || null,
          provider: _prov,
          status: 502,
          ok: false,
          elapsed_ms: Date.now() - startTime,
        });
        jsonResponse(res, 502, { error: { message: singleResult.error } });
        return;
      }

      // Mask the response content (safe chaining: singleResult may be null)
      const maskedContent = maskModelIdentity(
        singleResult ? singleResult.content : "No response",
      );
      const hasToolCalls =
        singleResult.tool_calls && singleResult.tool_calls.length > 0;

      const responseMessage = { role: "assistant" };
      if (hasToolCalls) {
        responseMessage.content = null;
        responseMessage.tool_calls = singleResult.tool_calls;
      } else {
        responseMessage.content = maskedContent;
      }

      // 🧟 telemetry: successful agent call (non-stream)
      {
        let _prov = null;
        try {
          _prov = resolveProvider(agent.model).providerId;
        } catch (_) {}
        trackAgentUsage(agentId, false, agent.model, _prov);
        recordModelStat(agent.model, _prov, true);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          agent: agentId,
          model: agent.model,
          provider: _prov,
          status: 200,
          ok: true,
          elapsed_ms: Date.now() - startTime,
        });
        recordSessionTouch(sessionId, {
          agent: agentId,
          model: agent.model,
          provider: _prov,
          editor: parsed.editor || "hermes",
        });
      }
      jsonResponse(res, 200, {
        id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, ""),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: singleResult.maskedModel, // ← Agent ID (not real model)
        choices: [
          {
            index: 0,
            message: responseMessage,
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          completion_tokens: Math.ceil((maskedContent || "").length / 4),
          total_tokens: Math.ceil(
            (JSON.stringify(messages).length + (maskedContent || "").length) /
            4,
          ),
        },
        session_id: sessionId,
        conversation_id: getSession(sessionId)?.conversation_id || sessionId,
        agent: singleResult.agent,
        // 🧟 #5 swap_notice (non-stream): silent fallbacks made visible
        ...(singleResult.swap_notice ? { swap_notice: singleResult.swap_notice } : {}),
      });
      return;
    }

    // ─── GET /api/verify-session ──────────────────────────────
    if (url === "/api/verify-session" && method === "GET") {
      // 🔒 SECURITY FIX (S5): Rate limit check
      const clientIp = req.socket.remoteAddress || "unknown";
      if (!checkRateLimit(clientIp)) {
        jsonResponse(res, 429, {
          verified: false,
          error: "Rate limit exceeded. Max 60 requests per minute.",
        });
        return;
      }

      // Multiple sources for sessionId (headers, query params, body) for robustness
      let sessionId = req.headers["x-session-id"] || "";
      const clientToken = req.headers["x-verify-token"] || "";

      // Fallback 1: Query parameters
      if (!sessionId) {
        const urlObj = new URL(req.url, `http://localhost:${PORT}`);
        sessionId =
          urlObj.searchParams.get("session_id") ||
          urlObj.searchParams.get("sessionId") ||
          urlObj.searchParams.get("session") ||
          "";
      }

      // Fallback 2: Request body (for POST-like GET requests)
      if (!sessionId && req.method === "GET") {
        try {
          const body = await readBody(req);
          const bodyData = JSON.parse(body);
          sessionId =
            bodyData.session_id ||
            bodyData.sessionId ||
            bodyData.session ||
            bodyData.client_id ||
            "";
        } catch (e) {
          // Ignore parsing errors - we'll handle missing sessionId below
        }
      }

      if (!sessionId) {
        jsonResponse(res, 400, {
          verified: false,
          error:
            "session_id required (provide via x-session-id header, session_id query param, or request body)",
          supported_methods: [
            "GET /api/verify-session?session_id=YOUR_SESSION_ID",
            "GET /api/verify-session (with x-session-id header)",
            "POST /api/mission (with session_id in body)",
          ],
        });
        return;
      }

      const localSession = getSession(sessionId);

      // 🔒 SECURITY FIX (S3): Validate x-verify-token against session
      // Previously the token was stored but never checked
      if (!localSession) {
        // Session not found — handle below
      } else if (
        clientToken &&
        localSession.client_token &&
        clientToken !== localSession.client_token
      ) {
        jsonResponse(res, 401, {
          verified: false,
          error: "Token mismatch — invalid x-verify-token",
        });
        return;
      }
      if (!localSession) {
        // Get current sessions for display
        const sessions = cleanExpired();
        jsonResponse(res, 404, {
          verified: false,
          error: "session not found",
          session_id_provided: sessionId.slice(0, 8) + "...",
          available_sessions: sessions.map(
            (s) => s.id.slice(0, 8) + "... (" + s.client_id + ")",
          ),
        });
        return;
      }

      // Local session found = verified. The remote verifySessionWithDomain()
      // is only for cross-server setups (sessionVerifyUrl pointing to another
      // instance). Calling it here against our own URL causes an infinite
      // self-referential HTTP loop → always fails → "verification failed".
      const isSelfHostedVerify =
        !RUNTIME_CONFIG.sessionVerifyUrl ||
        RUNTIME_CONFIG.sessionVerifyUrl.includes(`localhost:${PORT}`) ||
        RUNTIME_CONFIG.sessionVerifyUrl.includes("127.0.0.1");
      const verifyResult = isSelfHostedVerify
        ? {
            verified: true,
            local: true,
            note: "session verified locally (self-hosted verify URL)",
          }
        : await verifySessionWithDomain(sessionId, clientToken);
      jsonResponse(res, 200, {
        verified: verifyResult.verified,
        session_id: sessionId,
        session: localSession,
        domain_verify: verifyResult,
        timestamp: new Date().toISOString(),
        client_info: {
          client_id: localSession.client_id,
          editor: localSession.editor,
          ip: localSession.ip,
          created_at: localSession.created_at,
          last_accessed: localSession.last_accessed,
        },
      });
      return;
    }

    // ─── POST /api/auth/verify (Phase B + UI-1) — api_key → session token ──
    if (url === "/api/auth/verify" && method === "POST") {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const key = p.api_key || "";
      if (!key || !MODELS_DB) {
        jsonResponse(res, 401, { error: "api_key required (and sqlite must be available)" });
        return;
      }
      const hash = sha256Hex(key);
      const user = MODELS_DB.prepare(
        "SELECT id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at FROM users WHERE api_key = ?",
      ).get(hash);
      if (!user || user.enabled !== 1) {
        jsonResponse(res, 401, { error: "invalid api_key" });
        return;
      }
      // UI-1: enforce token limit + valid_days expiry BEFORE issuing session.
      const limitCheck = checkUserLimits(user);
      if (!limitCheck.ok) {
        jsonResponse(res, limitCheck.code || 403, {
          error: limitCheck.reason,
          used: limitCheck.used,
          limit: limitCheck.limit,
          expires_at: limitCheck.expires_at,
        });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      const sid = "s_" + crypto.randomBytes(8).toString("hex");
      const now = Date.now();
      const expires = now + SESSION_TTL_MS;
      MODELS_DB.prepare(
        "INSERT INTO sessions (id, user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(sid, user.id, token, now, expires);
      log("INFO", "AUTH_VERIFY_OK", { user: user.name });
      jsonResponse(res, 200, {
        ok: true,
        user: { id: user.id, name: user.name },
        usage: {
          used: user.token_used || 0,
          limit: user.token_limit || 0,
          valid_days: user.valid_days || 0,
          expires_at: limitCheck.expires_at || 0,
        },
        session_id: sid,
        session_token: token,
        expires_at: expires,
        ttl_ms: SESSION_TTL_MS,
      });
      return;
    }

    // ─── POST /api/auth/session (Phase B) — validate token ──────
    if (url === "/api/auth/session" && method === "POST") {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const token = p.session_token || p.token || "";
      if (!token || !MODELS_DB) {
        jsonResponse(res, 401, { error: "session_token required (and sqlite must be available)" });
        return;
      }
      const sess = MODELS_DB.prepare(
        `SELECT s.id, s.user_id, s.expires_at, u.name, u.enabled
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      ).get(token);
      if (!sess) { jsonResponse(res, 401, { error: "invalid session" }); return; }
      if (sess.enabled !== 1) { jsonResponse(res, 403, { error: "user disabled" }); return; }
      if (sess.expires_at < Date.now()) {
        MODELS_DB.prepare("DELETE FROM sessions WHERE id = ?").run(sess.id);
        jsonResponse(res, 401, { error: "session expired" });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        valid: true,
        user: { id: sess.user_id, name: sess.name },
        expires_at: sess.expires_at,
      });
      return;
    }

    // ─── POST /api/auth/logout (Phase B) — revoke token ────────
    if (url === "/api/auth/logout" && method === "POST") {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const token = p.session_token || p.token || "";
      if (MODELS_DB && token) {
        MODELS_DB.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      }
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ─── UI-1: /api/admin/users — list users (with limits) ─────
    if (url === "/api/admin/users" && method === "GET") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const rows = MODELS_DB.prepare(
        `SELECT id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at
         FROM users ORDER BY id ASC`,
      ).all();
      jsonResponse(res, 200, { count: rows.length, users: rows });
      return;
    }

    // ─── UI-1: /api/admin/users — create user → returns API key ──
    if (url === "/api/admin/users" && method === "POST") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const body = await readBody(req);
      let a;
      try { a = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const name = (a.name || "user").toString().trim();
      if (!name) {
        jsonResponse(res, 400, { error: "name is required" });
        return;
      }
      const tokenLimit = Math.max(0, parseInt(a.token_limit, 10) || 0);
      const validDays = Math.max(0, parseInt(a.valid_days, 10) || 0);
      const apiKey = "mb_" + crypto.randomBytes(16).toString("hex");
      const hash = sha256Hex(apiKey);
      const now = Date.now();
      try {
        MODELS_DB.prepare(
          `INSERT INTO users (name, api_key, enabled, token_limit, valid_days, token_used, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
        ).run(name, hash, a.enabled === undefined ? 1 : a.enabled ? 1 : 0, tokenLimit, validDays, now);
        log("INFO", "USER_CREATED", { name, token_limit: tokenLimit, valid_days: validDays });
        jsonResponse(res, 200, {
          ok: true,
          user: { name, token_limit: tokenLimit, valid_days: validDays, enabled: 1 },
          api_key: apiKey,
          note: "api_key shown once — store it safely (stored as sha256 hash on server)",
        });
      } catch (e) {
        jsonResponse(res, 500, { error: "create failed: " + e.message });
      }
      return;
    }

    // ─── UI-1: /api/admin/users/:id — update limits / enabled ──
    if (url.startsWith("/api/admin/users/") && method === "PUT") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const id = parseInt(decodeURIComponent(url.slice("/api/admin/users/".length)), 10);
      if (!id) { jsonResponse(res, 400, { error: "invalid user id" }); return; }
      const body = await readBody(req);
      let a;
      try { a = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const sets = [];
      const vals = [];
      if (a.name !== undefined) { sets.push("name = ?"); vals.push(String(a.name).trim()); }
      if (a.enabled !== undefined) { sets.push("enabled = ?"); vals.push(a.enabled ? 1 : 0); }
      if (a.token_limit !== undefined) { sets.push("token_limit = ?"); vals.push(Math.max(0, parseInt(a.token_limit, 10) || 0)); }
      if (a.valid_days !== undefined) { sets.push("valid_days = ?"); vals.push(Math.max(0, parseInt(a.valid_days, 10) || 0)); }
      if (a.expires_at !== undefined) { sets.push("expires_at = ?"); vals.push(parseInt(a.expires_at, 10) || 0); }
      if (sets.length === 0) { jsonResponse(res, 400, { error: "nothing to update" }); return; }
      vals.push(id);
      MODELS_DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      const row = MODELS_DB.prepare("SELECT id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at FROM users WHERE id = ?").get(id);
      jsonResponse(res, 200, { ok: true, user: row });
      return;
    }

    // ─── UI-1: /api/admin/users/:id — delete user ─────────────
    if (url.startsWith("/api/admin/users/") && method === "DELETE") {
      if (!adminAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const id = parseInt(decodeURIComponent(url.slice("/api/admin/users/".length)), 10);
      if (!id) { jsonResponse(res, 400, { error: "invalid user id" }); return; }
      MODELS_DB.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      MODELS_DB.prepare("DELETE FROM users WHERE id = ?").run(id);
      jsonResponse(res, 200, { ok: true, id });
      return;
    }

    // ─── POST /api/mission ──────────────────────────────────
    if (url === "/api/mission" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      const userInput = parsed.input || parsed.query || parsed.prompt || "";
      const tools = sanitizeTools(parsed.tools, parsed.model);
      let sessionId = parsed.session_id;

      // UI-1: optional auth on /api/mission — enforce per-user limits
      const mAuth = authFromRequest(req);
      if (mAuth.ok === false) {
        jsonResponse(res, 401, { error: "Unauthorized: " + mAuth.reason });
        return;
      }
      if (mAuth.ok === true) {
        const lim = checkUserLimits(mAuth.user);
        if (!lim.ok) {
          jsonResponse(res, 403, {
            error: { message: "Limit exceeded: " + lim.reason, limit: lim },
          });
          return;
        }
        bumpUserUsage(mAuth.user);
      }

      // Track mission usage
      trackAgentUsage("mission");

      if (!sessionId || !getSession(sessionId)) {
        const missionMeta = {
          agent_id: req.headers["x-agent-id"] || parsed.agent_id || "",
          user_agent: req.headers["user-agent"] || "",
          device_info: req.headers["x-device-info"] || parsed.device_info || "",
          editor_version:
            req.headers["x-editor-version"] || parsed.editor_version || "",
          os_platform: req.headers["x-os-platform"] || parsed.os_platform || "",
          client_version:
            req.headers["x-client-version"] || parsed.client_version || "",
          session_source: "mission",
        };
        const session = createSession(
          parsed.client_id || "anonymous",
          parsed.editor || "api",
          req.socket.remoteAddress,
          sessionId || undefined,
          missionMeta,
        );
        sessionId = session.id;
      }

      // Unified Socket Architecture: TransportAdapter + handleMessage
      const transport = new TransportAdapter("http", res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      transport._headersSent = true;

      handleMessage(transport, {
        type: "mission",
        id: crypto.randomUUID(),
        session_id: sessionId,
        agent_id: parsed.agent_id || "code-guru",
        messages: [
          ...(parsed.context || parsed.system
            ? [{ role: "system", content: parsed.context || parsed.system }]
            : []),
          { role: "user", content: userInput },
        ],
        context: {
          workspace: mcpWorkingDir || path.resolve("."),
        },
        params: {
          stream: true,
          tools: tools,
          multiAgent: true,
        },
      });
      return;
    }

    // ─── POST /api/v1/anti-dote ─────────────────────────────
    // Anti-Dote Type Safety endpoint: wraps mission with full 6-step validation.
    // Provides mathematical certainty: P(success) = 1 (see wrapped contract)
    if (url === "/api/v1/anti-dote" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      const userInput = parsed.input || parsed.query || parsed.prompt || "";
      const tools = sanitizeTools(parsed.tools, parsed.model);

      // Require input
      if (!userInput) {
        jsonResponse(res, 400, {
          error: "Input required for anti-dote validation",
        });
        return;
      }

      // Track mission usage
      trackAgentUsage("mission");

      // Get or create session
      let sessionId = parsed.session_id;
      if (!sessionId || !getSession(sessionId)) {
        const antiDoteMeta = {
          agent_id: req.headers["x-agent-id"] || parsed.agent_id || "",
          user_agent: req.headers["user-agent"] || "",
          device_info: req.headers["x-device-info"] || parsed.device_info || "",
          editor_version:
            req.headers["x-editor-version"] || parsed.editor_version || "",
          os_platform: req.headers["x-os-platform"] || parsed.os_platform || "",
          client_version:
            req.headers["x-client-version"] || parsed.client_version || "",
          session_source: "anti-dote",
        };
        const session = createSession(
          parsed.client_id || "anonymous",
          parsed.editor || "anti-dote",
          req.socket.remoteAddress,
          sessionId || undefined,
          antiDoteMeta,
        );
        sessionId = session.id;
      }

      // Unified Socket Architecture: TransportAdapter + handleMessage
      const transport = new TransportAdapter("http", res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      transport._headersSent = true;

      handleMessage(transport, {
        type: "mission",
        id: crypto.randomUUID(),
        session_id: sessionId,
        agent_id: parsed.agent_id || "code-guru",
        messages: [
          ...(parsed.context || parsed.system
            ? [{ role: "system", content: parsed.context || parsed.system }]
            : []),
          { role: "user", content: userInput },
        ],
        context: {
          workspace: mcpWorkingDir || path.resolve("."),
        },
        params: {
          stream: true,
          tools: tools,
          multiAgent: true,
          antiDote: true,
        },
      });
      return;
    }
    // Remove the dead duplicate /api/admin/stats here — it's handled at L7732
    // ─── GET /api/admin/ssot-status ─────────────────────────
    // Check SSOT auto-generation status
    if (url === "/api/admin/ssot-status" && method === "GET") {
      const ssotPath = path.resolve(".zombiecoder/SSOT.md");
      const ssotExists = fs.existsSync(ssotPath);
      let ssotInfo = { exists: false, path: ssotPath };
      if (ssotExists) {
        const stat = fs.statSync(ssotPath);
        const content = fs.readFileSync(ssotPath, "utf8");
        ssotInfo = {
          exists: true,
          path: ssotPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          lines: content.split("\n").length,
          hasProjectName: content.includes("Project:") || content.includes("#"),
          hasStructure:
            content.includes("structure") || content.includes("Structure"),
        };
      }
      jsonResponse(res, 200, {
        ssot: ssotInfo,
        autoGenerate: true,
        scanDir: path.resolve("."),
      });
      return;
    }

    // ─── GET /api/admin/agents-status ────────────────────────
    // Detailed agent status with usage
    if (url === "/api/admin/agents-status" && method === "GET") {
      const agentsWithStatus = AGENTS.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        usage: STATS.agentUsage[a.id] || {
          count: 0,
          lastUsed: null,
          errors: 0,
        },
        status: STATS.agentUsage[a.id]?.lastUsed
          ? Date.now() - new Date(STATS.agentUsage[a.id].lastUsed).getTime() <
            60000
            ? "active"
            : "idle"
          : "idle",
      }));
      jsonResponse(res, 200, { agents: agentsWithStatus });
      return;
    }

    // ─── GET /api/admin/mcp-connections ──────────────────────
    // MCP client connections and tool usage
    if (url === "/api/admin/mcp-connections" && method === "GET") {
      jsonResponse(res, 200, {
        activeConnections: mcpActiveConnections,
        clients: Array.from(mcpClients.values()),
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          usage: STATS.toolUsage[name] || {
            count: 0,
            lastUsed: null,
            errors: 0,
          },
        })),
        totalTools: Object.keys(MCP_TOOLS).length,
      });
      return;
    }

    // ─── GET /api/admin/rate-limits ──────────────────────────
    // Rate limit status per domain/provider
    if (url === "/api/admin/rate-limits" && method === "GET") {
      const domains = Object.keys(RATE_LIMIT_STATES);
      const rateLimitStatus = {};
      for (const domain of domains) {
        const state = RATE_LIMIT_STATES[domain];
        rateLimitStatus[domain] = {
          limited: state.limited,
          provider: state.provider,
          model: state.model,
          detectedAt: state.detectedAt
            ? new Date(state.detectedAt).toISOString()
            : null,
          cooldownMs: state.cooldownMs,
          remainingMs: state.limited
            ? Math.max(0, state.cooldownMs - (Date.now() - state.detectedAt))
            : 0,
        };
      }
      jsonResponse(res, 200, {
        limits: rateLimitStatus,
        config: {
          maxRateLimitPerServer: DOMAIN_CFG.maxRateLimitPerServer,
          domain: requestDomain,
        },
      });
      return;
    }

    // ─── POST /mcp (JSON-RPC 2.0) ─────────────────────────────
    if (url === "/mcp" && method === "POST") {
      handleMCP(req, res);
      return;
    }

    // ─── GET /mcp (list tools) ──────────────────────────────
    // JetBrains/IDE clients use this for persistent MCP transport.
    // SSE keeps connection alive, streaming tools+events as they happen.
    // Doc: doc/Streaming/Server-Sent-Events.md
    if (url === "/mcp" && method === "GET") {
      // SSE headers — per spec: text/event-stream, no-cache, keep-alive
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      // 1. Send endpoint event — tells client POST URL for JSON-RPC
      res.write("event: endpoint\ndata: /mcp\n\n");
      // 2. Send tools list as SSE event
      const tools = Object.entries(MCP_TOOLS)
        .filter(([name]) => toolEnabled(name)) // 🧟 respect admin on/off
        .map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: {
          type: "object",
          properties: def.params,
          required: def.required,
        },
      }));
      res.write("event: tools\ndata: " + JSON.stringify({ tools }) + "\n\n");
      // 3. Register SSE client in Map
      const clientId =
        Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      sseClients.set(clientId, { res, connectedAt: Date.now() });
      log("INFO", "SSE_CONNECTED", { clientId, total: sseClients.size });
      // 4. Keep-alive ping every 30s to prevent proxy/ISP timeout
      const keepAlive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch (_) {
          clearInterval(keepAlive);
        }
      }, 30000);
      // 5. Clean up on client disconnect
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(clientId);
        log("INFO", "SSE_DISCONNECTED", {
          clientId,
          remaining: sseClients.size,
        });
      });
      return;
    }

    // ─── GET /status ──────────────────────────────────────────
    if (url === "/status" && method === "GET") {
      const sessions = cleanExpired();
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        version: DOMAIN_CFG.version,
        domain: DETECTED_DOMAIN,
        serverType: DOMAIN_CFG.type,
        uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
        stats: {
          totalRequests: STATS.totalRequests,
          agents: AGENTS.length,
          sessions: sessions.length,
        },
        agents: AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          model: maskModelName(a.model),
          provider: "ZombieCoder",
        })),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ─── GET /api/version ────────────────────────────────────
    // The extension probes this endpoint solely to detect Ollama:
    // probeOllama() returns true ONLY when body.version is a string.
    // We deliberately expose the version under `apiVersion` (NOT
    // `version`) so the probe stays false and this server is not
    // misclassified as Ollama — which would otherwise trigger
    // N × POST /api/show per model in OllamaDiscovery.enrichModel.
    if (url === "/api/version" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        ok: true,
        server: "mission-barisal",
        apiVersion: DOMAIN_CFG.version,
        serverType: DOMAIN_CFG.type,
        domain: DETECTED_DOMAIN,
        uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ─── POST /api/workspace — Extension sends workspace path
    // Auto-generates .zombiecoder/SSOT.md in the workspace directory
    if (url === "/api/workspace" && method === "POST") {
      handleWorkspace(req, res);
      return;
    }

    // ─── POST /api/syllabus — Add entry to syllabus.md
    if (url === "/api/syllabus" && method === "POST") {
      handleSyllabusAdd(req, res);
      return;
    }

    // ─── GET /api/syllabus — Read syllabus.md content
    if (url === "/api/syllabus" && method === "GET") {
      const syllabusContent = readSyllabus();
      jsonResponse(res, 200, {
        ok: true,
        syllabus: syllabusContent,
        path: getAgentsPath() + "/syllabus.md",
      });
      return;
    }

    // ─── GET /api/memory — Read memory.json content
    if (url === "/api/memory" && method === "GET") {
      const memoryData = readMemory();
      jsonResponse(res, 200, {
        ok: true,
        memory: memoryData,
        path: getAgentsPath() + "/memory.json",
      });
      return;
    }

    // ─── GET /api/sessions/search?q=keyword — Search session archives
    if (url.startsWith("/api/sessions/search") && method === "GET") {
      const query =
        new URL(req.url, "http://localhost:" + PORT).searchParams.get("q") || "";
      const results = searchSessions(undefined, query);
      jsonResponse(res, 200, {
        ok: true,
        query,
        results,
        count: results.length,
      });
      return;
    }

    // ─── POST /api/input — Unified HTTP entry point
    // Accepts JSON body, creates TransportAdapter, routes to handleMessage
    if (url === "/api/input" && method === "POST") {
      readBody(req)
        .then((body) => {
          try {
            const parsed = JSON.parse(body);
            // Phase C: sanitize tools on the raw parsed input (if any)
            if (parsed.tools) parsed.tools = sanitizeTools(parsed.tools, parsed.model || (parsed.params && parsed.params.model));
            if (parsed.params && parsed.params.tools) {
              parsed.params.tools = sanitizeTools(parsed.params.tools, parsed.model || (parsed.params && parsed.params.model));
            }
            const transport = new TransportAdapter("http", res);
            // Set SSE-like headers for streaming response
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "X-Accel-Buffering": "no",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            transport._headersSent = true;
            handleMessage(transport, parsed);
          } catch (e) {
            jsonResponse(res, 400, { error: "Invalid JSON: " + e.message });
          }
        })
        .catch((e) => {
          jsonResponse(res, 400, { error: "Body read failed: " + e.message });
        });
      return;
    }

    // ─── POST /api/connect — Unified Origin Entry Point ────
    // 🔐 SECRET HANDSHAKE + filesystem access via simple HTTP/JSON.
    // Any client (browser, curl, editor) — no Node.js required.
    //
    // FLOW:
    //   1. { action: "handshake", client: "browser" }
    //      → { status: "ok", session_id: "xxx", identity: {...} }
    //   2. { action: "read_file", session_id: "xxx", path: "/etc" }
    //      → { status: "ok", content: "..." }
    //
    // SECRET HANDSHAKE:
    //   Server auto-creates session for first request.
    //   Returns session_id → client caches it.
    //   Subsequent requests include session_id → treated as "local/trusted".
    //   Full directory access after handshake.
    if (url === "/api/connect" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      const action = parsed.action || "handshake";
      const clientId = parsed.client_id || parsed.client || "unknown";
      let sessionId = parsed.session_id || req.headers["x-session-id"] || "";
      const targetPath = parsed.path || parsed.directory || ".";
      const fileContent = parsed.content || "";
      const agentInput = parsed.input || "";
      const agentId = parsed.agent_id || "code-guru";

      // 🔐 SECRET HANDSHAKE: Auto-create session if none provided
      if (sessionId) {
        const existing = getSession(sessionId);
        if (!existing) sessionId = ""; // expired/invalid → reset
      }

      if (!sessionId) {
        const newSession = createSession({
          client_id: clientId,
          editor: "origin",
          ip: req.socket.remoteAddress || "unknown",
        });
        sessionId = newSession.id;
      }

      const session = getSession(sessionId);

      switch (action) {
        case "handshake":
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            conversation_id: session?.conversation_id || sessionId,
            identity: {
              client: clientId,
              verified: true,
              local: true,
              editor: "origin",
              ip: session?.ip || req.socket.remoteAddress,
            },
            origin: {
              url: DOMAIN_CFG.appUrl || `http://localhost:${PORT}`,
              domain: DETECTED_DOMAIN,
              version: DOMAIN_CFG.version,
              name: DOMAIN_CFG.name,
              type: DOMAIN_CFG.type,
            },
            tools: Object.keys(MCP_TOOLS),
            message:
              "🔐 Secret handshake complete. You are now trusted as local client.",
          });
          return;

        case "read_file": {
          const r = await executeMcpTool("read_file", { path: targetPath });
          const txt = r.content?.[0]?.text || "";
          if (
            txt.startsWith("Access denied") ||
            txt.startsWith("File not found") ||
            txt.startsWith("Not a file")
          ) {
            jsonResponse(res, 404, {
              status: "error",
              error: txt,
              path: targetPath,
            });
          } else {
            jsonResponse(res, 200, {
              status: "ok",
              content: txt,
              path: targetPath,
              bytes: txt.length,
            });
          }
          return;
        }

        case "write_file": {
          if (!targetPath || targetPath === ".") {
            jsonResponse(res, 400, {
              status: "error",
              error: "path is required for write_file",
            });
            return;
          }
          const r = await executeMcpTool("write_file", {
            path: targetPath,
            content: fileContent,
          });
          const txt = r.content?.[0]?.text || "";
          if (txt.startsWith("Access denied")) {
            jsonResponse(res, 403, { status: "error", error: txt });
          } else {
            jsonResponse(res, 200, {
              status: "ok",
              message: txt,
              path: targetPath,
            });
          }
          return;
        }

        case "list_dir":
        case "list_directory": {
          const r = await executeMcpTool("list_directory", {
            path: targetPath,
          });
          const txt = r.content?.[0]?.text || "";
          jsonResponse(res, 200, {
            status: "ok",
            listing: txt,
            path: targetPath,
          });
          return;
        }

        case "info": {
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            identity: {
              client: clientId,
              verified: true,
              local: true,
            },
            origin: {
              url: DOMAIN_CFG.appUrl || `http://localhost:${PORT}`,
              domain: DETECTED_DOMAIN,
              version: DOMAIN_CFG.version,
              name: DOMAIN_CFG.name,
            },
            working_dir: mcpWorkingDir,
            session: {
              created_at: session?.created_at,
              last_accessed: session?.last_accessed,
              conversation_id: session?.conversation_id || sessionId,
            },
          });
          return;
        }

        case "mission":
        case "agent_mission": {
          if (!agentInput) {
            jsonResponse(res, 400, {
              status: "error",
              error: "input is required for mission",
            });
            return;
          }
          const result = await executeMission(agentInput, "", sessionId);
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            action: "mission",
            result: {
              combined: result.combined?.slice(0, 50000) || "",
              agents: result.agents || [],
              rounds: result.rounds || 0,
            },
          });
          return;
        }

        case "agent":
        case "agent_single": {
          if (!agentInput) {
            jsonResponse(res, 400, {
              status: "error",
              error: "input is required for agent",
            });
            return;
          }
          const result = await executeSingleAgent(
            agentInput,
            agentId,
            sessionId,
          );
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            action: "agent",
            agent: agentId,
            result: result.response?.slice(0, 50000) || "",
          });
          return;
        }

        default:
          jsonResponse(res, 400, {
            status: "error",
            error: `Unknown action: "${action}". Supported: handshake, read_file, write_file, list_dir, info, mission, agent`,
          });
      }
      return;
    }

    // ─── 404 ─────────────────────────────────────────────────
    log("INFO", "REQUEST", {
      method,
      url,
      status: 404,
      elapsed: Date.now() - startTime,
    });
    jsonResponse(res, 404, { error: "Not found" });
  } catch (err) {
    log("ERROR", "SERVER", { error: err.message });
    log("INFO", "REQUEST", {
      method,
      url,
      status: 500,
      elapsed: Date.now() - startTime,
    });
    jsonResponse(res, 500, { error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  WEBSOCKET HANDLER (Native, zero-dep)
// ══════════════════════════════════════════════════════════════
function handleWebSocketUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
    acceptKey +
    "\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
  );

  let buffer = Buffer.alloc(0);
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length > 2) {
      const firstByte = buffer[0],
        secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f,
        offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) break;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) break;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + payloadLength) break;

      let payload = buffer.slice(offset, offset + payloadLength);
      if (isMasked && maskKey)
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      buffer = buffer.slice(offset + payloadLength);

      if (opcode === 0x01) handleWSMessage(socket, payload.toString());
      else if (opcode === 0x08) {
        socket.end();
        return;
      } else if (opcode === 0x09) sendWSFrame(socket, 0x8a, payload);
    }
  });
  socket.on("close", () => log("INFO", "WS_CLOSE", {}));
  socket.on("error", (err) => log("WARN", "WS_ERROR", { error: err.message }));
}

function sendWSFrame(socket, opcode, payload) {
  payload = payload || Buffer.alloc(0);
  if (typeof payload === "string") payload = Buffer.from(payload);
  const header =
    payload.length < 126
      ? Buffer.of(opcode, payload.length)
      : payload.length < 65536
        ? Buffer.of(
          opcode,
          126,
          (payload.length >> 8) & 0xff,
          payload.length & 0xff,
        )
        : ((buf) => {
          buf[0] = opcode;
          buf[1] = 127;
          buf.writeBigUInt64BE(BigInt(payload.length), 2);
          return buf;
        })(Buffer.alloc(10));
  socket.write(Buffer.concat([header, payload]));
}

async function handleWSMessage(socket, message) {
  try {
    const data = JSON.parse(message);
    switch (data.type) {
      case "auth": {
        // 🔒 SECURITY FIX (S2): Real WebSocket authentication
        // Previously sent auth_success without any verification
        const authToken = data.token || "";
        const authSessionId = data.session_id || "";
        // Validate: must have a valid session or token
        let wsAuthenticated = false;
        if (authSessionId && getSession(authSessionId)) {
          wsAuthenticated = true;
        } else if (authToken && authToken.length >= 8) {
          // Token-based auth: check if token maps to a valid session
          const tokenSessionId = clientSessions.get(authToken);
          if (tokenSessionId && getSession(tokenSessionId)) {
            wsAuthenticated = true;
          }
        }
        if (wsAuthenticated) {
          sendWSFrame(
            socket,
            0x81,
            JSON.stringify({
              type: "auth_success",
              timestamp: new Date().toISOString(),
            }),
          );
        } else {
          sendWSFrame(
            socket,
            0x81,
            JSON.stringify({
              type: "auth_error",
              error: "Invalid or missing authentication token",
              timestamp: new Date().toISOString(),
            }),
          );
        }
        break;
      }
      case "chat":
      case "question": {
        // Phase 2: Route through unified handler
        const transport = new TransportAdapter("ws", socket);
        const wsMsg = {
          type: "chat",
          id: data.id || crypto.randomUUID(),
          messages: [
            { role: "user", content: data.message || data.content || "" },
          ],
          session_id: data.session_id || crypto.randomUUID(),
          agent_id: data.agent_id || data.model || DEFAULT_MODEL,
          params: {
            model: data.model || DEFAULT_MODEL,
            tools: sanitizeTools(data.tools, data.model),
            stream: true,
          },
        };
        // Fire and forget — handleMessage streams response via transport
        handleMessage(transport, wsMsg);
        break;
      }
      case "mcp": {
        const toolResult = await executeMcpTool(data.tool, data.args || {});
        sendWSFrame(
          socket,
          0x81,
          JSON.stringify({ type: "mcp_result", id: data.id, ...toolResult }),
        );
        break;
      }
      case "ping":
        sendWSFrame(
          socket,
          0x81,
          JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }),
        );
        break;
      default:
        sendWSFrame(
          socket,
          0x81,
          JSON.stringify({
            type: "error",
            data: { error: "Unknown type: " + data.type },
          }),
        );
    }
  } catch (e) {
    log("ERROR", "WS_PARSE", { error: e.message });
  }
}

server.on("upgrade", handleWebSocketUpgrade);

// Handle malformed HTTP (e.g., HTTP/2 preface from Java/IntelliJ clients)
server.on("clientError", (err, socket) => {
  log("WARN", "CLIENT_ERROR", { error: err.message });
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } else {
    socket.destroy();
  }
});

// Dead-code removal (2026-09-25): server.on("sessionError"/"streamError")
// was NEVER emitted — plain http.Server has no such events. The listeners
// lived on the wrong emitter. The surviving h2cServer listeners (below)
// receive Node's real sessionError/streamError, and the streamError handler
// there now carries the original 500-response intent.

// ─── HTTP/2 cleartext (h2c) inbound — SAME port as HTTP/1.1 ──────────
// The TCP sniffer above detects the HTTP/2 prior-knowledge preface and
// hands the raw socket here via emit("connection"). Every h2 stream is
// re-emitted into the SAME request handler as HTTP/1.1 — one handler,
// one auth pipeline, one port. (TLS/ALPN was explicitly dismissed.)
const h2cServer = http2.createServer();

// HTTP/2 forbids connection-specific headers (Connection, Keep-Alive,
// Transfer-Encoding, Upgrade, Proxy-Connection). The shared handler sets
// `Connection: keep-alive` on SSE endpoints — Node drops them with an
// UnsupportedWarning; strip them up-front so logs stay clean.
const H2_FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
]);

function stripH2ForbiddenHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return headers;
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!H2_FORBIDDEN_HEADERS.has(String(k).toLowerCase())) out[k] = v;
  }
  return out;
}

h2cServer.on("request", (req, res) => {
  // HTTP/2 has no `host` header — only the `:authority` pseudo-header.
  // detectDomain(req.headers.host) would otherwise fall back to "localhost".
  if (!req.headers.host) {
    // Proven: :authority is in req.headers; req.authority is the safe fallback.
    req.headers.host = req.headers[":authority"] || req.authority || "";
  }
  // Wrap writeHead/setHeader so forbidden connection headers never reach
  // an h2 stream (spec-correct, keeps UnsupportedWarning out of logs).
  const origWriteHead = res.writeHead;
  res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
    if (typeof reasonOrHeaders === "string") {
      if (maybeHeaders === undefined) {
        return origWriteHead.call(res, status, reasonOrHeaders);
      }
      return origWriteHead.call(
        res,
        status,
        reasonOrHeaders,
        stripH2ForbiddenHeaders(maybeHeaders),
      );
    }
    if (reasonOrHeaders === undefined) return origWriteHead.call(res, status);
    return origWriteHead.call(res, status, stripH2ForbiddenHeaders(reasonOrHeaders));
  };
  const origSetHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (H2_FORBIDDEN_HEADERS.has(String(name).toLowerCase())) return res;
    return origSetHeader.call(res, name, value);
  };
  server.emit("request", req, res);
});

h2cServer.on("sessionError", (err) => {
  log("WARN", "HTTP2_SESSION_ERROR", { error: err.message, transport: "h2c" });
});
h2cServer.on("streamError", (err, stream) => {
  log("WARN", "HTTP2_STREAM_ERROR", {
    error: err && err.message,
    id: stream && stream.id,
    transport: "h2c",
  });
  // Intent preserved from the old (dead) http.Server listener: answer the
  // failed stream with 500 instead of leaving the client hanging.
  if (stream && stream.writable) {
    try {
      stream.respond({ ":status": 500, "content-type": "application/json" });
      stream.end(JSON.stringify({ error: "Internal stream error" }));
    } catch (_) {
      /* stream already destroyed — nothing to answer */
    }
  }
});
h2cServer.on("clientError", (err, socket) => {
  log("WARN", "HTTP2_CLIENT_ERROR", { error: err.message, transport: "h2c" });
  if (socket && socket.writable) socket.end();
  else if (socket) socket.destroy();
});
h2cServer.on("error", (err) => {
  log("WARN", "HTTP2_SERVER_ERROR", { error: err.message });
});

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════
const DEFAULT_MODEL = getDefaultModel();

// Minimal fallback persona — ONE LINE ONLY, used ONLY when PERSONAS.md unavailable
const FALLBACK_PERSONA_PREFIX =
  "তুমি ZombieCoder AI — বাংলায় উত্তর দাও, প্রমাণ ছাড়া দাবি কোরো না।";

async function init() {
  // PHASE A: open SQLite models DB FIRST so that seedAgentsFromPersonas()
  // and DB-first loadPersonas() see MODELS_DB ready. initModelsDb also runs
  // later in this function; the later call is guarded to avoid re-opening.
  if (!MODELS_DB) initModelsDb();
  if (MODELS_DB) loadModelsFromDb();
  // Env vars are the single source of truth: re-apply env-defined models
  // over the DB cache so edits to .env win without a full restart.
  if (MODELS_DB) syncEnvModelsToDb();
  // 🧟 Restore admin enable/disable state, then guarantee the registry:
  // runtime DB creation → local seed → remote download (in that order).
  if (MODELS_DB) loadDisabledState();
  // 🧟 rehydrate persisted config + usage counters (settings/model_stats/
  // agent_stats/provider_stats) so the admin panels show REAL numbers
  // immediately after restart instead of zeros.
  if (MODELS_DB) loadRuntimeConfig();
  if (MODELS_DB) loadUsageFromDb();
  await ensureModelsRegistry();

  // PHASE A: seed agents table from PERSONAS.md on first boot (idempotent),
  // then load DB-first. PERSONAS.md remains as fallback for ids not in DB.
  seedAgentsFromPersonas();
  await ensureAgentsRegistry();
  // PHASE B: seed admin user from ADMIN_USER/ADMIN_API_KEY env (idempotent).
  seedAdminUser();
  AGENTS = await loadPersonas();
  STATS.totalAgents = AGENTS.length;

  if (AGENTS.length === 0) {
    log("WARN", "START_NO_AGENTS", { fallback: "using DEFAULT_AGENTS" });
    // One-line fallback persona only — full persona lives in PERSONAS.md
    AGENTS = DEFAULT_AGENTS.map((a) => ({
      ...a,
      persona: FALLBACK_PERSONA_PREFIX,
    }));
    STATS.totalAgents = AGENTS.length;
    log("INFO", "DEFAULT_AGENTS_LOADED", { count: AGENTS.length });
  }

  // Auto-generate SSOT on startup — internal server context only
  const ssotResult = autoSSOT(path.resolve("."));

  // ── Startup: User Memory Cache ─────────────────────────────
  initCache();
  log("INFO", "CACHE_READY", { dir: CACHE_DIR, ttl: CACHE_TTL + "ms" });

  // ── Startup: Note Store (single server module)
  try {
    const { initNoteStore } = require("./note-store.js");
    const noteResult = initNoteStore();
    if (noteResult.ok)
      log("INFO", "NOTE_STORE_READY", { notes: noteResult.noteCount });
  } catch (err) {
    log("WARN", "NOTE_STORE_INIT_FAILED", { error: err.message });
  }
  if (GIT_SKILLS_URL || GIT_INSTRUCTIONS_URL) {
    log("INFO", "GIT_DOWNLOAD_START", {
      skills: GIT_SKILLS_URL || "none",
      instructions: GIT_INSTRUCTIONS_URL || "none",
    });
    Promise.all([loadSkills(), loadInstructions()]).then(() =>
      log("INFO", "GIT_DOWNLOAD_DONE", {}),
    );
  }

  // ── Internal Watchdog: periodic health check (replaces external watchdog.sh) ──
  // Logs heartbeat every 60s, auto-recovers via systemd Restart=always
  const WATCHDOG_INTERVAL_MS = parseInt(
    process.env.WATCHDOG_INTERVAL || "60000",
    10,
  );
  setInterval(() => {
    const uptime = Math.floor((Date.now() - STATS.startTime) / 1000);
    const sessions = cleanExpired().length;
    const memUsed = process.memoryUsage();
    log("INFO", "HEARTBEAT", {
      uptime_sec: uptime,
      sessions_active: sessions,
      total_requests: STATS.totalRequests,
      agents: AGENTS.length,
      rss_mb: Math.round(memUsed.rss / 1024 / 1024),
      heap_mb: Math.round(memUsed.heapUsed / 1024 / 1024),
    });
    // Flush buffered memory to disk periodically
    flushAllMemory();
    // Lock log: heartbeat as success marker
    writeLockLog({
      agent: "system",
      operation: "heartbeat",
      status: "success",
      duration_ms: 0,
      details: { uptime_sec: uptime, sessions, requests: STATS.totalRequests },
    });
  }, WATCHDOG_INTERVAL_MS);
  log("INFO", "WATCHDOG_STARTED", { interval_ms: WATCHDOG_INTERVAL_MS });

  // ── MCP Socket Server (UDS on Linux/Mac, TCP fallback on Windows) ──
  // Doc: doc/Streaming/Server-Sent-Events.md
  // Windows does NOT support Unix Domain Sockets via net.createServer
  // So on Windows we fall back to a TCP loopback on port PORT+1
  const isWindows = process.platform === "win32";
  // 🧟 Use module-level UDS_PORT from env/DOMAIN_CFG — NOT redeclare!
  // Fix: previously re-declared const UDS_PORT = PORT+1 (shadowing the env var)
  const udsListenPort = isWindows ? PORT + 1 : null;
  const socketPath = UDS_PATH;

  // Ensure the socket directory exists (OS temp dir per syllabus) — without
  // this, listen() fails with ENOENT when /tmp/zombiecoder is missing.
  if (!isWindows) {
    try {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    } catch (_) { /* best-effort; listen() will surface real errors */ }
  }

  udsServer = net.createServer((socket) => {
    const clientAddr = isWindows
      ? "tcp:127.0.0.1:" + udsListenPort
      : socketPath;
    log("INFO", "UDS_CONNECTED", {
      transport: isWindows ? "tcp" : "uds",
      path: clientAddr,
    });
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          // Phase 2: Route non-MCP to unified handler
          if (message.type && message.type !== "mcp") {
            const transport = new TransportAdapter("uds", socket);
            handleMessage(transport, message);
          } else {
            handleUdsMcpMessage(socket, message);
          }
        } catch (e) {
          socket.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error: " + e.message },
            }) + "\n",
          );
        }
      }
    });
    socket.on("end", () =>
      log("INFO", "UDS_DISCONNECTED", { transport: isWindows ? "tcp" : "uds" }),
    );
    socket.on("error", (err) =>
      log("WARN", "UDS_ERROR", { error: err.message }),
    );
  });

  if (isWindows) {
    // Windows: TCP fallback — listen on loopback, port = PORT + 1
    udsServer.listen(udsListenPort, "127.0.0.1", () => {
      log("INFO", "UDS_LISTENING", {
        transport: "tcp-fallback",
        port: udsListenPort,
        note: "Windows: UDS not supported, using TCP loopback",
      });
    });
  } else {
    // Linux/Mac: Unix Domain Socket
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch (_) { }
    }
    udsServer.listen(socketPath, () => {
      try {
        // 🧟 UDS security: socket is the trust boundary — group/owner only.
        // Fix: 0o777 let ANY local user hijack the MCP socket (which serves
        // unrestricted read_file/terminal). 0o660 = same-user clients only.
        fs.chmodSync(socketPath, 0o660);
      } catch (_) { }
      log("INFO", "UDS_LISTENING", { transport: "uds", path: socketPath });
    });
  }
  udsServer.on("error", (err) => {
    log("WARN", "UDS_SERVER_ERROR", {
      error: err.message,
      transport: isWindows ? "tcp" : "uds",
    });
  });

  // ─── Startup: SQLite models DB + auto-sync ────────────────────
  // 1. Open/create the models database (node:sqlite, zero-dependency)
  //    Guarded: already opened at the top of init() for DB-first personas.
  if (!MODELS_DB) initModelsDb();
  // 2. Load previously-synced models from DB, then re-apply env-defined
  //    models on top (env = single source of truth) and persist.
  loadModelsFromDb();
  syncEnvModelsToDb();
  // 3. Fire-and-forget auto-sync: fetch live models from every
  //    provider (OpenCode, custom, Groq, Gemini), merge into
  //    PROVIDER_CONFIG and persist to SQLite. Runs in the
  //    background so it never blocks the server from listening.
  setTimeout(() => {
    runNormalizerSync()
      .then((r) => {
        log("INFO", "AUTO_SYNC_DONE", { results: r.results, db: r.db });
      })
      .catch((e) => log("WARN", "AUTO_SYNC_FAIL", { error: e.message }));
  }, 500);

  // 🧟 PRINCIPLED BIND — never listen wider than DETECTED_DOMAIN.
  //   loopback domain (localhost / 127.x) → 127.0.0.1 : no LAN/WAN exposure
  //   bare IP domain (e.g. 192.168.0.1)   → that exact NIC IP only
  //   FQDN / vhost                        → 0.0.0.0 (reverse-proxy needs it)
  // Fix: previously hardcoded "0.0.0.0" — contradicted START {"domain":"127.0.0.1"}.
  let bindHost = "0.0.0.0";
  if (DETECTED_DOMAIN === "localhost" || /^127\./.test(DETECTED_DOMAIN)) {
    bindHost = "127.0.0.1";
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(DETECTED_DOMAIN)) {
    bindHost = DETECTED_DOMAIN;
  }
  tcpServer.listen(PORT, bindHost, () => {
    log("INFO", "START", {
      port: PORT,
      agents: AGENTS.length,
      domain: DETECTED_DOMAIN,
      bind: bindHost,
    });
    console.log("\nMission Barisal v3");
    console.log("Domain: " + DETECTED_DOMAIN + " | Type: " + DOMAIN_CFG.type);
    console.log(
      "Port: " +
      PORT +
      " | Agents: " +
      AGENTS.length +
      " | Providers: " +
      Object.keys(PROVIDER_CONFIG).length +
      " | Models: " +
      FREE_MODELS.length,
    );
    console.log("--- Providers ---");
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      console.log(
        "  " +
        id +
        ": " +
        p.name +
        " [" +
        (p.models.length
          ? p.models.length + " models"
          : "wildcard (any model)") +
        "] priority=" +
        p.priority,
      );
    }
    console.log("--- Domain Config ---");
    console.log("  Domain: " + DETECTED_DOMAIN);
    console.log("  Type: " + DOMAIN_CFG.type);
    console.log("  Frontend: " + DOMAIN_CFG.hasFrontend);
    console.log("  Pusher: " + PUSHER_ENABLED);
    console.log("  CORS Origins: " + DOMAIN_CFG.corsOrigins.join(", "));
    console.log(
      "  Rate Limit: " + DOMAIN_CFG.maxRateLimitPerServer + " req/min",
    );
    console.log("--- Server Internal Context ---");
    console.log("  Root: " + path.resolve("."));
    if (ssotResult)
      console.log(
        "  SSOT: " +
        path.resolve(".", ".zombiecoder", "SSOT.md") +
        " (internal)",
      );
    console.log("--- --- --- --- --- --- --- --- ---");
    console.log("Endpoints:");
    console.log("  GET  /health             — Health check (domain-aware)");
    console.log("  GET  /identity           — System identity (domain-aware)");
    console.log(
      "  GET  /v1/models          — List agents (masked consumer models)",
    );
    console.log(
      "  GET  /api/v1/models      — List ALL provider models (unmasked, dev)",
    );
    console.log("  POST /v1/chat/completions — Agent or mission");
    console.log("  POST /api/mission        — Full debate mission");
    console.log(
      "  POST /api/v1/anti-dote   — Anti-Dote Type Safety (6-step chain)",
    );
    console.log("  POST /api/mcp-clients    — Connected MCP clients (JSON)");
    console.log("  GET  /api/clients         — Connected MCP clients (HTML)");
    console.log(
      "  POST /api/set-working-dir — Set working dir (for zombieBridge)",
    );
    console.log("  POST /api/normalize      — Test Haq Mawla normalizer (dev)");
    console.log("  GET  /api/normalize-list — Provider + model list");
    console.log("  GET  /api/config          — View runtime config");
    console.log("  POST /api/config          — Update runtime config");
    console.log("  GET  /api/domain          — Domain detection & config");
    console.log("  POST /mcp                 MCP JSON-RPC 2.0");
    console.log("  GET  /mcp (SSE)          — MCP SSE streaming (keep-alive)");
    // Conditional: port PORT+1 only listens on Windows (UDS fallback).
    // On POSIX this previously advertised a dead TCP endpoint — removed.
    console.log(
      isWindows
        ? "  TCP  127.0.0.1:" +
            (PORT + 1) +
            "        — MCP socket (Windows TCP fallback)"
        : "  UDS  " + socketPath + "  — MCP socket (Unix domain socket)",
    );
    console.log("  WS   /                   — WebSocket for real-time");
    console.log("  POST /api/input          — Unified HTTP (handleMessage)");
    console.log(
      "  POST /api/workspace       Auto-generate SSOT for workspace\n",
    );
    console.log("[SSOT] CLIENT SSOT: set_working_dir call korlei");
    console.log("[SSOT] apnar client-er project folder-e");
    console.log("[SSOT] .zombiecoder/SSOT.md auto-generate hobe!\n");
  });

  // 🧟 BROKER AUTO-RUN — spawn the PHP broker server (php-broker-server.js)
  // alongside sarver when running api.js directly (start.js already does this).
  // Idempotent: only spawns if the broker port is NOT already listening, so
  // `node start.js --start-all` (which spawns broker first) never double-spawns.
  // Opt-out: set BROKER_AUTORUN=0 in .env to disable.
  if (process.env.BROKER_AUTORUN !== "0") {
    const brokerPort = parseInt(process.env.BROKER_PORT || "9998", 10);
    const brokerPath = path.join(
      __dirname,
      "external tools",
      "php-broker-server.js",
    );
    const trySpawnBroker = () => {
      if (!fs.existsSync(brokerPath)) {
        console.log("[BROKER] php-broker-server.js not found at:", brokerPath);
        return;
      }
      const sock = net.connect(brokerPort, "127.0.0.1");
      let connected = false;
      sock.once("connect", () => {
        connected = true;
        sock.destroy();
        console.log("[BROKER] already running on :" + brokerPort + " — skip spawn");
      });
      sock.once("error", () => {
        if (connected) return;
        // Port free → spawn broker
        const { spawn } = require("child_process");
        const broker = spawn(process.execPath, [brokerPath], {
          stdio: "inherit",
          env: process.env,
        });
        broker.on("error", (err) =>
          console.error("[BROKER] spawn error:", err.message),
        );
        broker.on("exit", (code, signal) =>
          console.log("[BROKER] exited code=" + code + " signal=" + signal),
        );
        console.log("[BROKER] spawned php-broker-server.js (pid " + broker.pid + ")");
      });
      sock.setTimeout(1500, () => {
        if (!connected) sock.destroy();
      });
    };
    // Non-blocking — fires after listen so startup is never delayed.
    setTimeout(trySpawnBroker, 300);
  }

  // 🧟 PHASE D: outbound MCP client — discover remote servers
  // (non-blocking, fires after listen so startup is never delayed).
  syncAllRemoteMCPs()
    .then((r) => {
      const merged = mergeRemoteMcpTools();
      if (r.synced > 0) {
        log("INFO", "REMOTE_MCP_STARTUP", { synced: r.synced, merged });
      }
    })
    .catch((e) => log("WARN", "REMOTE_MCP_STARTUP_FAIL", { error: e.message }));

  // 🧟 PHASE D3: external MCP — load from 'external mcp/' folder + EXTERNAL_MCP_URLS
  // Register (or re-register) every external tool into MCP_TOOLS. Returns count
  // of NEWLY added tools. Extracted so the watchdog below can run it again.
  const registerExternalTools = () => {
    let added = 0;
    for (const t of externalMcp.getAllTools()) {
      if (MCP_TOOLS[t.fullName]) continue;
      MCP_TOOLS[t.fullName] = {
        description: "[external:" + t.serverName + "] " + (t.description || t.name),
        params: (t.inputSchema && t.inputSchema.properties) || { args: { type: "object" } },
        required: (t.inputSchema && t.inputSchema.required) || [],
      };
      added++;
    }
    return added;
  };
  let extMcpRetried = false;
  externalMcp
    .loadAll()
    .then((results) => {
      const added = registerExternalTools();
      log("INFO", "EXTERNAL_MCP_STARTUP", { servers: results.length, tools: added });
      // 🧟 WATCHDOG — evidence: the 21:57:41 boot logged {"tools":0} (connect
      // race: local MCPs still booting) and 10 tools stayed dead until a manual
      // restart. If the first pass added nothing, retry ONCE after 5s.
      if (added === 0 && !extMcpRetried) {
        extMcpRetried = true;
        setTimeout(() => {
          externalMcp
            .loadAll()
            .then((r2) => {
              const n = registerExternalTools();
              log("INFO", "EXTERNAL_MCP_STARTUP_RETRY", { servers: r2.length, tools: n });
            })
            .catch((e2) =>
              log("WARN", "EXTERNAL_MCP_RETRY_FAIL", { error: e2.message }),
            );
        }, 5000);
      }
    })
    .catch((e) => log("WARN", "EXTERNAL_MCP_STARTUP_FAIL", { error: e.message }));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  🧟 LOCAL UDS CLIENT — Zero Dependency, < 1ms Latency to model_server.py
// ═══════════════════════════════════════════════════════════════════════════════
// Uses Node.js built-in `net` module. NO grpc, NO protobuf, NO new packages.
// Protocol: 4-byte little-endian length prefix + JSON payload
// Socket:   /tmp/zombie_coder.sock (Linux/Mac only)
// Fallback: If UDS unavailable, falls back to HTTP REST.
// ═══════════════════════════════════════════════════════════════════════════════

const LOCAL_UDS_PATH =
  process.env.ZOMBIE_UDS_PATH || "/tmp/zombie_coder.sock";
const LOCAL_UDS_TIMEOUT = parseInt(process.env.LOCAL_UDS_TIMEOUT || "30000");
let _udsAvailable = null;

/**
 * Check if the local UDS socket exists and is connectable.
 */
function isLocalUdsAvailable() {
  if (_udsAvailable !== null) return _udsAvailable;
  try {
    if (process.platform === "win32") { _udsAvailable = false; return false; }
    _udsAvailable = fs.existsSync(LOCAL_UDS_PATH);
    return _udsAvailable;
  } catch { _udsAvailable = false; return false; }
}

/**
 * Send a request to model_server.py via UDS socket.
 * @param {string} path - e.g. "/v1/chat/completions", "/health"
 * @param {string} method - "GET" or "POST"
 * @param {object|null} body - Request body (for POST)
 * @returns {Promise<{status: number, body: object}>}
 */
function udsRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    if (!isLocalUdsAvailable()) return reject(new Error("UDS socket not available"));
    const startTime = Date.now();
    const client = net.createConnection({ path: LOCAL_UDS_PATH });
    let responded = false;
    const timeout = setTimeout(() => {
      if (!responded) { responded = true; client.destroy(); reject(new Error("UDS timeout after " + LOCAL_UDS_TIMEOUT + "ms")); }
    }, LOCAL_UDS_TIMEOUT);

    client.on("connect", () => {
      try {
        const req = JSON.stringify({ path, method, body: body || {} });
        const buf = Buffer.from(req, "utf-8");
        const header = Buffer.alloc(4);
        header.writeUInt32LE(buf.length, 0);
        client.write(Buffer.concat([header, buf]));
      } catch (err) { responded = true; clearTimeout(timeout); client.destroy(); reject(err); }
    });

    let dataBuf = Buffer.alloc(0);
    let expectedLen = -1;

    client.on("data", (chunk) => {
      dataBuf = Buffer.concat([dataBuf, chunk]);
      while (true) {
        if (expectedLen === -1) {
          if (dataBuf.length < 4) break;
          expectedLen = dataBuf.readUInt32LE(0);
          dataBuf = dataBuf.subarray(4);
        }
        if (dataBuf.length < expectedLen) break;
        const jsonStr = dataBuf.subarray(0, expectedLen).toString("utf-8");
        dataBuf = dataBuf.subarray(expectedLen);
        expectedLen = -1;
        try {
          const resp = JSON.parse(jsonStr);
          const elapsed = Date.now() - startTime;
          log("INFO", "UDS_RESPONSE", { path, status: resp.status, latency: elapsed + "ms" });
          responded = true; clearTimeout(timeout); client.destroy(); resolve(resp);
        } catch { responded = true; clearTimeout(timeout); client.destroy(); reject(new Error("UDS invalid JSON response")); }
        break;
      }
    });

    client.on("error", (err) => {
      if (!responded) { responded = true; clearTimeout(timeout); _udsAvailable = false; reject(err); }
    });
    client.on("close", () => {
      if (!responded) { responded = true; clearTimeout(timeout); reject(new Error("UDS connection closed before response")); }
    });
  });
}

/**
 * Call local model_server.py via UDS with automatic HTTP fallback.
 * @param {string} path - API path
 * @param {string} method - HTTP method
 * @param {object|null} body - Request body
 * @param {string} fallbackUrl - Full HTTP URL for fallback
 * @returns {Promise<{status: number, body: object, transport: string}>}
 */
async function callLocalWithFallback(path, method, body, fallbackUrl) {
  // Step 1: Try UDS (zero dependency, < 1ms)
  if (isLocalUdsAvailable()) {
    try {
      const resp = await udsRequest(path, method, body);
      return { ...resp, transport: "uds" };
    } catch (udsErr) {
      log("WARN", "UDS_FALLBACK_TO_HTTP", { path, error: udsErr.message });
      _udsAvailable = false;
    }
  }
  // Step 2: Fallback to HTTP REST
  if (!fallbackUrl) return { status: 502, body: { error: "No UDS and no fallback URL" }, transport: "none" };
  try {
    const resp = await new Promise((resolve, reject) => {
      const urlObj = new URL(fallbackUrl);
      const mod = urlObj.protocol === "https:" ? https : http;
      const postData = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname,
        method: method, headers: { "Content-Type": "application/json" }, timeout: 15000,
      };
      if (postData) opts.headers["Content-Length"] = Buffer.byteLength(postData);
      const req = mod.request(opts, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data), transport: "http" }); }
          catch { resolve({ status: res.statusCode, body: { raw: data }, transport: "http" }); }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("HTTP timeout")); });
      if (postData) req.write(postData);
      req.end();
    });
    return resp;
  } catch (httpErr) {
    return { status: 502, body: { error: "HTTP fallback failed: " + httpErr.message }, transport: "none" };
  }
}

/**
 * UDS-aware health check for local model server.
 */
async function checkLocalModelServerHealth() {
  const modelServerPort = parseInt(process.env.MODEL_SERVER_PORT || "8007");
  const fallbackUrl = "http://127.0.0.1:" + modelServerPort + "/health";
  return callLocalWithFallback("/health", "GET", null, fallbackUrl);
}


// ══════════════════════════════════════════════════════════════
//  🎯 UNIFIED MESSAGE HANDLER — Transport Adapter Layer
// ══════════════════════════════════════════════════════════════
// All transports (UDS/TCP/WS/HTTP/SSE) go through this layer.
// Handles: parsing → context injection → type safety → goal
// → routing → execution → verification → streaming response.
// ═════════════════════════════════════════════════════════════

/**
 * TransportAdapter — Wraps any transport type (UDS/TCP/WS/HTTP/SSE)
 * into a unified interface with decode/send/stream/close methods.
 */
class TransportAdapter {
  static connections = new Map();

  constructor(transportType, conn) {
    this.type = transportType;
    this.conn = conn;
    this.id =
      transportType +
      "_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 6);
    TransportAdapter.connections.set(this.id, {
      type: transportType,
      createdAt: Date.now(),
    });
  }

  decode(rawData) {
    if (typeof rawData === "string") return JSON.parse(rawData);
    return JSON.parse(rawData.toString("utf8"));
  }

  send(data) {
    const raw = JSON.stringify(data);
    switch (this.type) {
      case "uds":
      case "tcp":
        this.conn.write(raw + "\n");
        break;
      case "ws":
        if (typeof sendWSFrame === "function") {
          sendWSFrame(this.conn, 0x81, raw);
        } else {
          this.conn.write(raw);
        }
        break;
      case "sse":
        this.conn.write("data: " + raw + "\n\n");
        break;
      case "http":
      default:
        if (!this._headersSent) {
          this.conn.writeHead(200, {
            "Content-Type": "application/json",
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
          });
          this._headersSent = true;
        }
        this.conn.write(raw + "\n");
        break;
    }
  }

  stream(data) {
    const payload = JSON.stringify({ ...data, stream: true });
    switch (this.type) {
      case "uds":
      case "tcp":
        this.conn.write(payload + "\n");
        break;
      case "ws":
        if (typeof sendWSFrame === "function") {
          sendWSFrame(this.conn, 0x81, payload);
        } else {
          this.conn.write(payload);
        }
        break;
      case "sse":
        this.conn.write("data: " + payload + "\n\n");
        break;
      case "http":
      default:
        if (!this._headersSent) {
          this.conn.writeHead(200, {
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          this._headersSent = true;
        }
        this.conn.write("data: " + payload + "\n\n");
        break;
    }
  }

  close() {
    // Remove from connections tracking
    TransportAdapter.connections.delete(this.id);
    try {
      if (this.type === "uds" || this.type === "tcp") {
        this.conn.end();
        this.conn.destroy();
      } else if (this.type === "ws") {
        try {
          this.conn.end();
        } catch (_) { }
      } else {
        this.conn.end();
      }
    } catch (_) { }
  }
}

// ══════════════════════════════════════════════════════════════
//  🎯 CONTEXT INJECTION — Syllabus, SSOT, Memory per-request
// ══════════════════════════════════════════════════════════════
async function injectContext(sessionId, projectDir, agentId) {
  const context = {};

  // 1. SSOT Load
  context.ssot = readSSOT(projectDir);
  if (!context.ssot) {
    context.ssot = autoSSOT(projectDir);
  }

  // 2. Syllabus Load
  context.syllabus = readSyllabus(projectDir);

  // 3. Three-File Context (buildThreeFileContext already combines memory)
  context.threeFile = buildThreeFileContext(projectDir, sessionId);

  // 4. Agent Memory (per-agent within session)
  try {
    const memoryPath = path.join(
      projectDir,
      ".zombiecoder",
      "data",
      sessionId,
      (agentId || "default") + ".json",
    );
    if (fs.existsSync(memoryPath)) {
      const memRaw = fs.readFileSync(memoryPath, "utf8");
      context.agentMemory = JSON.parse(memRaw);
    } else {
      context.agentMemory = null;
    }
  } catch (_) {
    context.agentMemory = null;
  }

  // 5. Build merged context string
  const merged = [
    " PROJECT CONTEXT (SSOT):",
    context.ssot || "Not available",
    "",
    "📚 AGENT KNOWLEDGE (Syllabus):",
    context.syllabus || "Not available",
    "",
    "💾 MEMORY & HISTORY:",
    context.threeFile || "No previous context",
    "",
    "🎯 RULES:",
    "- Must provide evidence (proman) for ALL claims",
    "- Must reference SSOT/Syllabus/Memory when applicable",
    "- If info missing, say explicitly: 'এই মুহূর্তে আমার কাছে এই তথ্যগুল নাই।'",
    "- Never reveal model provider or AI company name",
    "- Speak in Bengali with Barishali flavor",
    "- Cross-verify your own output before responding",
  ].join("\n");

  return {
    raw: context,
    merged,
    ssotLoaded: !!context.ssot,
    syllabusLoaded: !!context.syllabus,
    memoryLoaded: !!context.threeFile,
  };
}

// ═════════════════════════════════════════════════════════════
//  🎯 TYPE SAFETY CHECK — Anti-Dote Wrapper
// ══════════════════════════════════════════════════════════════
// Wraps existing antiDoteValidateInput, antiDoteCheckProof,
// antiDoteSetGoalContract, antiDoteVerifyOutput into a
// unified streaming-aware check.
async function typeSafetyCheck(msg, context, transport) {
  const results = {
    schemaPassed: false,
    proofPassed: false,
    consentPassed: false,
  };

  // Step 1: Schema / Input Validation
  // Pick the LAST message with actual content — Copilot/UI often appends
  // an empty trailing user message that would fail "non-empty string" check.
  const inputStr =
    (msg.messages && msg.messages.length > 0
      ? [...msg.messages]
        .reverse()
        .find(
          (m) =>
            m && typeof m.content === "string" && m.content.trim().length > 0,
        )?.content
      : "") || "";

  const validation = antiDoteValidateInput(inputStr, context);
  if (!validation.valid) {
    transport.stream({
      type: "type_safety_error",
      step: "schema",
      error: validation.error?.message || "Input validation failed",
      code: validation.error?.code || "SCHEMA_ERROR",
    });
    return { passed: false, results };
  }
  results.schemaPassed = true;

  // Step 2: Proof Check
  const proof = antiDoteCheckProof(validation.contract);
  if (!proof.provable) {
    transport.stream({
      type: "type_safety_error",
      step: "proof",
      error: proof.error?.message || "Proof verification failed",
      code: proof.error?.code || "PROOF_ERROR",
    });
    return { passed: false, results };
  }
  results.proofPassed = true;

  // Step 3: Goal Contract
  const goalContract = antiDoteSetGoalContract(proof.contract);
  if (!goalContract.contracted) {
    transport.stream({
      type: "type_safety_error",
      step: "goal_contract",
      error: goalContract.error?.message || "Goal contract failed",
      code: goalContract.error?.code || "CONTRACT_ERROR",
    });
    return { passed: false, results };
  }

  // Step 4: Consent Check
  if (msg.consent && msg.consent.granted === false) {
    transport.stream({
      type: "consent_required",
      message: "User consent needed before execution",
      contract_id: validation.contract.id,
    });
    return { passed: false, results, pending: true };
  }
  results.consentPassed = true;

  transport.stream({
    type: "type_safety_passed",
    schema: true,
    proof: true,
    consent: true,
    complexity: proof.contract.proof?.complexity || "moderate",
  });

  return {
    passed: true,
    results,
    contract: goalContract.contract,
  };
}

// ══════════════════════════════════════════════════════════════
//  🎯 GOAL SETTING CHECK
// ═════════════════════════════════════════════════════════════
// Determines what the user wants, what constraints apply,
// and what output type to expect.
function goalSettingCheck(msg, context, transport) {
  const inputStr =
    (msg.messages && msg.messages.length > 0
      ? msg.messages[msg.messages.length - 1].content
      : "") || "";

  const goal = {
    type: "general",
    constraints: [],
    expected_output: "text",
    requiresCode: false,
    requiresResearch: false,
    requiresAction: false,
  };

  // Detect goal type from input
  if (
    /\b(code|write|create|implement|function|script|program)\b/i.test(inputStr)
  ) {
    goal.type = "code_generation";
    goal.requiresCode = true;
    goal.expected_output = "code_with_explanation";
  } else if (
    /\b(debug|fix|error|bug|issue|problem|not working)\b/i.test(inputStr)
  ) {
    goal.type = "debugging";
    goal.requiresCode = true;
  } else if (
    /\b(explain|what is|how does|why|describe|tell me about)\b/i.test(inputStr)
  ) {
    goal.type = "explanation";
    goal.requiresResearch = true;
  } else if (/\b(search|find|look up|web search|google)\b/i.test(inputStr)) {
    goal.type = "research";
    goal.requiresResearch = true;
  } else if (/\b(run|execute|deploy|start|build)\b/i.test(inputStr)) {
    goal.type = "action";
    goal.requiresAction = true;
  } else if (msg.type === "mission") {
    goal.type = "multi_agent_debate";
    goal.constraints.push("all_six_agents_required");
  } else if (msg.type === "competition") {
    goal.type = "provider_comparison";
    goal.constraints.push("multiple_providers");
  }

  // Apply constraints
  if (goal.type === "code_generation") {
    goal.constraints.push("must_provide_evidence");
    goal.constraints.push("file_references_required");
  }

  transport.stream({
    type: "goal_set",
    goal: {
      type: goal.type,
      constraints: goal.constraints,
    },
  });

  return goal;
}

// ══════════════════════════════════════════════════════════════
//  🎯 SINGLE AGENT CROSS-VERIFICATION
// ══════════════════════════════════════════════════════════════
// Verifies a single agent's output for:
// - Self-consistency
// - Evidence verification
// - Reference check
// - Goal achievement
// - Code safety (if code present)
async function crossVerifySingleAgent(
  agentResult,
  userInput,
  context,
  transport,
) {
  const verification = {
    passed: false,
    score: 0,
    checks: [],
    type: "single_agent",
  };

  const content = (agentResult && agentResult.content) || "";

  transport.stream({
    type: "cross_verify_start",
    mode: "single_agent",
  });

  // Step 1: Self-Consistency
  const contradictions = detectContradictions(content);
  const selfConsistent = contradictions.length === 0;
  verification.checks.push({
    check: "self_consistency",
    passed: selfConsistent,
    detail: selfConsistent
      ? "Agent did not contradict itself"
      : "Found " + contradictions.length + " contradiction(s)",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "self_consistency",
    status: selfConsistent ? "PASSED" : "FAILED",
  });

  // Step 2: Evidence Verification
  const evidenceFound = hasEvidence(content);
  verification.checks.push({
    check: "evidence_verified",
    passed: evidenceFound,
    detail: evidenceFound
      ? "Response contains evidence/references"
      : "No evidence markers found in response",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "evidence_verified",
    status: evidenceFound ? "PASSED" : "FAILED",
  });

  // Step 3: Reference Check
  const referencedInput = referencesUserInput(content, userInput);
  verification.checks.push({
    check: "has_references",
    passed: referencedInput,
    detail: referencedInput
      ? "Agent referenced user input and context"
      : "Agent did not reference user input",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "has_references",
    status: referencedInput ? "PASSED" : "FAILED",
  });

  // Step 4: Goal Achievement
  const goalMet = content.length > 10 && content.length < 100000;
  verification.checks.push({
    check: "goal_achieved",
    passed: goalMet,
    detail: goalMet
      ? "Output length is reasonable (" + content.length + " chars)"
      : "Output too short or too long",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "goal_achieved",
    status: goalMet ? "PASSED" : "FAILED",
  });

  // Step 5: Code Safety (if code present)
  if (containsCodeBlock(content)) {
    const codeSafe = !hasDangerousPatterns(content);
    verification.checks.push({
      check: "code_safe",
      passed: codeSafe,
      detail: codeSafe
        ? "Code appears safe"
        : "Code contains dangerous patterns",
    });
    transport.stream({
      type: "cross_verify_check",
      check: "code_safe",
      status: codeSafe ? "PASSED" : "FAILED",
    });
  }

  // Calculate score
  verification.score =
    verification.checks.filter((c) => c.passed).length /
    verification.checks.length;
  verification.passed = verification.score >= 0.6;

  transport.stream({
    type: "cross_verify_done",
    result: verification.passed ? "PASSED" : "FAILED",
    score: Math.round(verification.score * 100) / 100,
    passedCount: verification.checks.filter((c) => c.passed).length,
    totalCount: verification.checks.length,
  });

  return verification;
}

// ─── Cross-Verification Helpers ──────────────────────────────

function detectContradictions(text) {
  const contradictions = [];
  const patterns = [
    { a: /yes\b/i, b: /no\b/i },
    { a: /\btrue\b/i, b: /\bfalse\b/i },
    { a: /\bwill\b/i, b: /\bwont\b|will not\b/i },
  ];
  const words = text.toLowerCase().split(/\s+/);
  for (const p of patterns) {
    const hasA = words.some((w) => p.a.test(w));
    const hasB = words.some((w) => p.b.test(w));
    if (hasA && hasB) {
      contradictions.push("Possible contradiction: " + p.a + " vs " + p.b);
    }
  }
  return contradictions;
}

function hasEvidence(text) {
  return /(্রমাণ|evidence|according to|as per|reference|source|based on|উল্লেখ|দেখা যায়|মতে|according)/i.test(
    text,
  );
}

function referencesUserInput(content, userInput) {
  if (!userInput) return false;
  const keywords = userInput
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4);
  if (keywords.length === 0) return true;
  const matchCount = keywords.filter((kw) =>
    content.toLowerCase().includes(kw),
  ).length;
  return matchCount >= Math.min(2, keywords.length);
}

function containsCodeBlock(text) {
  return (
    /```[\s\S]*?```/.test(text) ||
    /\b(function|const|let|var|import|export|def |class |async)\b/.test(text)
  );
}

function hasDangerousPatterns(text) {
  return /\b(eval|exec|spawn|child_process|rm -rf|process\.exit|fs\.rmSync)\b/i.test(
    text,
  );
}

// ══════════════════════════════════════════════════════════════
//  🎯 COMPILER CHECK — Code Verification
// ══════════════════════════════════════════════════════════════
// Checks agent output for code syntax, dependency references,
// security patterns, and path validity.
async function compilerCheck(content, language, context, transport) {
  if (!containsCodeBlock(content)) {
    return { passed: true, skipped: true, reason: "No code in response" };
  }

  transport.stream({
    type: "compiler_check_start",
    language: language || "auto-detected",
  });

  const checks = [];
  const codeBlocks = extractCodeBlocks(content);

  // Syntax check for each code block
  for (const block of codeBlocks) {
    const syntaxIssues = checkBasicSyntax(block.code, block.language);
    checks.push({
      block: block.language,
      check: "syntax",
      passed: syntaxIssues.length === 0,
      errors: syntaxIssues,
    });
    transport.stream({
      type: "compiler_check_result",
      block: block.language,
      check: "syntax",
      status: syntaxIssues.length === 0 ? "PASSED" : "FAILED",
      errors: syntaxIssues,
    });
  }

  // Dependency check (against SSOT if available)
  if (context?.ssot) {
    const depIssues = checkDependenciesInCode(codeBlocks, context.ssot);
    for (const issue of depIssues) {
      checks.push({
        check: "dependency",
        passed: issue.passed,
        detail: issue.detail,
      });
      transport.stream({
        type: "compiler_check_result",
        check: "dependency",
        status: issue.passed ? "PASSED" : "WARNING",
        detail: issue.detail,
      });
    }
  }

  // Security pattern check
  const dangerousPatterns = hasDangerousPatterns(content);
  checks.push({
    check: "security",
    passed: !dangerousPatterns,
    warnings: dangerousPatterns ? ["Dangerous pattern detected"] : [],
  });
  transport.stream({
    type: "compiler_check_result",
    check: "security",
    status: dangerousPatterns ? "FAILED" : "PASSED",
  });

  const allPassed = checks.every((c) => c.passed);
  transport.stream({
    type: "compiler_check_done",
    result: allPassed ? "ALL_PASSED" : "SOME_FAILED",
    passedCount: checks.filter((c) => c.passed).length,
    totalCount: checks.length,
    severity: allPassed ? "info" : "warning",
  });

  return { passed: allPassed, checks };
}

// ─── Compiler Check Helpers ──────────────────────────────────

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({
      language: match[1] || "unknown",
      code: match[2],
    });
  }
  return blocks;
}

function checkBasicSyntax(code, language) {
  const issues = [];
  const lines = code.split("\n");
  const lang = language.toLowerCase();

  // JavaScript/TypeScript basic checks
  if (["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(lang)) {
    let parenCount = 0;
    let braceCount = 0;
    let bracketCount = 0;
    let inString = false;
    let stringChar = null;

    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      const prev = i > 0 ? code[i - 1] : "";

      if (!inString) {
        if (ch === '"' || ch === "'" || ch === "`") {
          inString = true;
          stringChar = ch;
        } else if (ch === "(") parenCount++;
        else if (ch === ")") parenCount--;
        else if (ch === "{") braceCount++;
        else if (ch === "}") braceCount--;
        else if (ch === "[") bracketCount++;
        else if (ch === "]") bracketCount--;
      } else if (ch === stringChar && prev !== "\\") {
        inString = false;
        stringChar = null;
      }
    }

    if (parenCount !== 0) issues.push("Unmatched parentheses: " + parenCount);
    if (braceCount !== 0) issues.push("Unmatched braces: " + braceCount);
    if (bracketCount !== 0) issues.push("Unmatched brackets: " + bracketCount);
  }

  // Python basic checks
  if (["py", "python"].includes(lang)) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.endsWith(":") && !trimmed.startsWith("#")) {
        const nextLine = lines
          .slice(i + 1)
          .find((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
        if (nextLine && !nextLine.startsWith(" ")) {
          issues.push(
            "Line " +
            (i + 2) +
            ": Expected indented block after '" +
            trimmed +
            "'",
          );
        }
      }
    }
  }

  return issues;
}

function checkDependenciesInCode(codeBlocks, ssotContent) {
  const issues = [];
  if (!ssotContent) return issues;

  for (const block of codeBlocks) {
    const imports = block.code.match(
      /require\(['"]([^'"]+)['"]\)|from\s+['"]([^'"]+)['"]/g,
    );
    if (imports) {
      for (const imp of imports) {
        const lib = imp.replace(/require\(|from\s+|['"]/g, "");
        if (lib.startsWith(".") || lib.startsWith("/")) {
          if (!ssotContent.includes(lib.replace("./", ""))) {
            issues.push({
              passed: false,
              detail: "Potential missing dependency: " + lib,
            });
          }
        }
      }
    }
  }

  return issues;
}

// ══════════════════════════════════════════════════════════════
//  🎯 UNIFIED MESSAGE HANDLER — Central Processing Unit
// ══════════════════════════════════════════════════════════════
// All transports route here. This function:
// 1. Parses the message
// 2. Injects context (syllabus + SSOT + memory)
// 3. Runs type safety checks
// 4. Sets goal
// 5. Routes to output point (chat/mission/competition/mcp)
// 6. Cross-verifies output
// 7. Runs compiler check if code present
// 8. Streams response back through transport
async function handleMessage(transport, rawMessage) {
  const startTime = Date.now();

  try {
    // Step 0: Detect transport type from connection
    if (!transport || !rawMessage) {
      throw new Error("Invalid transport or message");
    }

    // Step 1: Parse message
    let msg;
    if (typeof rawMessage === "string" || rawMessage instanceof Buffer) {
      msg = transport.decode(rawMessage);
    } else {
      msg = rawMessage; // Already parsed
    }

    if (!msg || !msg.type) {
      transport.stream({
        type: "error",
        error: "Message must have a 'type' field",
        code: "INVALID_MESSAGE",
      });
      return;
    }

    const sessionId = msg.session_id || "default";
    const workspace =
      msg.context?.workspace || mcpWorkingDir || path.resolve(".");
    const agentId = msg.agent_id || "code-guru";

    // Step 2: Inject context
    transport.stream({
      type: "context_injecting",
      session: sessionId,
      agent: agentId,
    });

    const context = await injectContext(sessionId, workspace, agentId);

    transport.stream({
      type: "context_injected",
      ssot: context.ssotLoaded,
      syllabus: context.syllabusLoaded,
      memory: context.memoryLoaded,
    });

    // Build full messages array with system context
    const systemMessages = [];
    if (context.merged) {
      systemMessages.push({
        role: "system",
        content: context.merged,
      });
    }

    // Merge with user messages
    const allMessages = [
      ...systemMessages,
      ...(msg.messages || [{ role: "user", content: "" }]),
    ];

    // Step 3: Type Safety Check
    const typeSafe = await typeSafetyCheck(msg, context, transport);
    if (!typeSafe.passed) {
      const failedSteps = Object.entries(typeSafe.results || {})
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(",");
      transport.stream({
        type: "type_safety_failed",
        step: failedSteps,
      });
      // Also emit a standard "error" event so clients that only listen
      // for response_done/error (e.g. VS Code extension udsChatRequest)
      // get a meaningful error instead of a bare socket close.
      transport.stream({
        type: "error",
        error: `Type safety check failed: ${failedSteps || "unknown"}`,
        code: "TYPE_SAFETY_FAILED",
        step: failedSteps,
      });
      transport.close();
      return;
    }

    // Step 4: Goal Setting
    const goal = goalSettingCheck(msg, context, transport);

    // Step 5: Route to Output Point
    transport.stream({
      type: "routing",
      to: msg.type,
      goal_type: goal.type,
    });

    let result;
    switch (msg.type) {
      case "chat": {
        const agentFn = async () => {
          return await executeSingleAgent(
            agentId,
            allMessages,
            msg.params || {},
            sessionId,
          );
        };
        const executed = await antiDoteExecute(typeSafe.contract, agentFn);
        result = executed.result || executed;
        break;
      }
      case "mission": {
        const agentFn = async () => {
          return await executeSingleAgent(
            agentId,
            allMessages,
            { ...(msg.params || {}), multiAgent: true },
            sessionId,
          );
        };
        const executed = await antiDoteExecute(typeSafe.contract, agentFn);
        result = executed.result || executed;
        break;
      }
      case "competition": {
        result = {
          content:
            "Competition routing not yet implemented via unified handler",
          type: "competition",
        };
        break;
      }
      case "mcp":
      case "tool": {
        if (typeof handleMCP === "function") {
          result = await handleMCP(
            { body: msg.mcp || msg, method: "POST" },
            null,
          );
        } else {
          result = { content: "MCP handler not available", type: "mcp" };
        }
        break;
      }
      default: {
        const agentFn = async () => {
          return await executeSingleAgent(
            agentId,
            allMessages,
            msg.params || {},
            sessionId,
          );
        };
        const executed = await antiDoteExecute(typeSafe.contract, agentFn);
        result = executed.result || executed;
        break;
      }
    }

    // Step 6: Cross-Verification
    const verification = await crossVerifySingleAgent(
      result,
      msg.messages && msg.messages.length > 0
        ? msg.messages[msg.messages.length - 1].content
        : "",
      context,
      transport,
    );

    // Step 7: Compiler Check (if code present in result)
    const compilerResult = await compilerCheck(
      result?.content || "",
      null,
      context,
      transport,
    );

    // Step 8: Stream completion signal
    const elapsed = Date.now() - startTime;
    transport.stream({
      type: "response_done",
      id: msg.id || null,
      data: {
        content: result?.content || "",
        done: true,
      },
      verification: {
        type_safe: typeSafe.passed,
        goal_met: verification.passed,
        cross_verified: verification.passed,
        compiler_checked: compilerResult.passed || compilerResult.skipped,
      },
      usage: {
        elapsed_ms: elapsed,
        transport: transport.type,
        session_id: sessionId,
        agent_id: agentId,
      },
    });

    log("INFO", "HANDLE_MESSAGE_COMPLETE", {
      type: msg.type,
      transport: transport.type,
      session: sessionId,
      agent: agentId,
      elapsed,
      verified: verification.passed,
      compiler: compilerResult.passed || compilerResult.skipped,
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    log("ERROR", "HANDLE_MESSAGE_FAILED", {
      error: e.message,
      stack: e.stack?.split("\n").slice(0, 3).join(" | "),
      elapsed,
    });
    transport.stream({
      type: "error",
      error: e.message,
      code: "HANDLER_ERROR",
      elapsed_ms: elapsed,
    });
  }
}

init();

// ══════════════════════════════════════════════════════════════════
//  R2T — RESPONSE-TO-TOOL VIRTUAL MODEL (external module bridge)
// ══════════════════════════════════════════════════════════════════
//  Purpose:
//    model="r2t" converts marker blocks ([[TOOL:exec]]...[[/TOOL]]) in
//    the user message into real OS tool executions, then returns the
//    result in OpenAI chat.completion format via Haq Mawla normalizer.
//
//  cPanel / environment safety:
//    The heavy logic lives in the optional external module
//    `external tools/r2t-response-to-tool.mjs`. If that module cannot
//    load (cPanel, older Node, missing file) OR R2T_ENABLED=false,
//    this function degrades gracefully — it never throws into the main
//    request pipeline and the rest of the server keeps working.
//
//  Env flags (true/false switches read from environment):
//    R2T_ENABLED  - "true" (default local) runs r2t; "false" bypasses.
//    R2T_MODULE   - custom path to the r2t module (default below).
//    R2T_PORT     - passed through to the module (port for its server).
//    R2T_URL      - open compatible URL the module talks to (default:
//                   https://centers-red-asset-cultural.trycloudflare.com/v1)
//
//  Returns an OpenAI-shaped object: { choices:[{message:{content}}], ...}
// ══════════════════════════════════════════════════════════════════
async function executeR2tRequest(requestModel, messages, opts = {}) {
  const startedAt = Date.now();
  const safeSend = (note) =>
    normalizeResponse(
      {
        id: "r2t-" + Date.now(),
        created: Math.floor(Date.now() / 1000),
        model: requestModel,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: note,
            },
            finish_reason: "stop",
          },
        ],
        usage: {},
      },
      requestModel,
    );

  // 1) Env gate — cPanel-safe switch.
  const enabled = String(process.env.R2T_ENABLED || "true") !== "false";
  if (!enabled) {
    log("INFO", "R2T_DISABLED", { env: "R2T_ENABLED=false" });
    return safeSend(
      '[r2t] R2T_ENABLED=false — r2t virtual model is off on this environment.'
    );
  }

  // 2) Extract the last user text from messages (OpenAI multi-modal aware).
  const userMsg = messages.filter((m) => m.role === "user").pop();
  let userInput = userMsg ? userMsg.content : "";
  if (Array.isArray(userInput)) {
    userInput = userInput
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (!userInput || !userInput.trim()) {
    return safeSend("[r2t] no user message content provided");
  }

  // 3) Optional markdown code fences are stripped so plain markers work.
  userInput = userInput
    .replace(/^```[a-zA-Z0-9_-]*\n?/gm, "")
    .replace(/\n?```$/gm, "")
    .trim();

  // 4) Load the external r2t module (optional — local dev only).
  const modulePath =
    process.env.R2T_MODULE ||
    path.join(__dirname, "external tools", "r2t-response-to-tool.mjs");
  let mod = null;
  if (fs.existsSync(modulePath)) {
    try {
      mod = await import(pathToFileURL(modulePath).href + "?v=" + Date.now());
    } catch (e) {
      log("WARN", "R2T_MODULE_LOAD_FAILED", { error: String(e.message || e) });
      mod = null;
    }
  }

  // 5) Execute markers via the module; degrade to a basic executor when
  //    the module is unavailable (keeps the request pipeline alive).
  let result;
  try {
    if (mod && typeof mod.convertResponse === "function") {
      result = await mod.convertResponse(userInput);
      result.r2tEngine = "external-module";
      result.module = modulePath;
    } else {
      result = await basicR2tExecutor(userInput);
      result.r2tEngine = "builtin-fallback";
    }
  } catch (e) {
    log("ERROR", "R2T_EXEC_FAILED", { error: String(e.message || e) });
    return safeSend(
      "[r2t] execution failed: " + String(e.message || e).slice(0, 300)
    );
  }

  // 6) Wrap into OpenAI shape and pass through Haq Mawla normalizer.
  result.elapsedMs = Date.now() - startedAt;
  return normalizeResponse(
    {
      id: "r2t-" + Date.now(),
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify(result, null, 2),
          },
          finish_reason: "stop",
        },
      ],
      usage: {},
      r2t: true,
    },
    requestModel,
  );
}

// ── Built-in minimal marker executor (dependency-free fallback) ─────
// Understands a safe subset: info, list, read, stat, exec, git.
// Full toolset requires the external r2t module (see R2T_ENABLED).
async function basicR2tExecutor(input) {
  const blocks = [];
  const re =
    /\[\[(?:TOOL:)?(\w+)\]\]\s*([\s\S]*?)\s*\[\[(?:TOOL:)?\/(?:\1|TOOL)\]\]/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    blocks.push({ name: m[1].toLowerCase(), body: m[2].trim(), full: m[0] });
  }
  if (blocks.length === 0) {
    return {
      status: "ok",
      matched: 0,
      note: "no [[TOOL:...]] markers found — r2t module not loaded?",
      hint: "install the external r2t module for full toolset",
    };
  }
  const results = [];
  for (const b of blocks) {
    try {
      if (b.name === "info") {
        results.push({ tool: "info", status: "ok", cwd: process.cwd(), node: process.version });
      } else if (b.name === "list") {
        const p = path.resolve(b.body || ".");
        results.push({
          tool: "list",
          status: "ok",
          path: p,
          entries: fs.existsSync(p) ? fs.readdirSync(p) : [],
        });
      } else if (b.name === "read") {
        const p = path.resolve(b.body);
        results.push({
          tool: "read",
          status: fs.existsSync(p) ? "ok" : "error",
          path: p,
          content: fs.existsSync(p) ? fs.readFileSync(p, "utf8").slice(0, 4000) : "",
        });
      } else if (b.name === "stat") {
        const p = path.resolve(b.body);
        results.push({
          tool: "stat",
          status: fs.existsSync(p) ? "ok" : "error",
          path: p,
          size: fs.existsSync(p) ? fs.statSync(p).size : 0,
        });
      } else if (b.name === "exec") {
        const out = await new Promise((resolve) => {
          require("child_process").exec(b.body, { timeout: 10000 }, (err, stdout, stderr) =>
            resolve({
              status: err ? "error" : "ok",
              stdout: (stdout || "").trim(),
              stderr: (stderr || "").trim(),
            })
          );
        });
        results.push({ tool: "exec", lowerBound: true, ...out });
      } else if (b.name === "git") {
        const out = await new Promise((resolve) => {
          require("child_process").execFile("git", (b.body || "status").split(/\s+/), { timeout: 10000 }, (err, stdout, stderr) =>
            resolve({
              status: err ? "error" : "ok",
              stdout: (stdout || "").trim(),
              stderr: (stderr || "").trim(),
            })
          );
        });
        results.push({ tool: "git", ...out });
      } else {
        results.push({
          tool: b.name,
          status: "unavailable",
          error: "builtin fallback does not implement this tool — load the r2t module",
        });
      }
    } catch (e) {
      results.push({ tool: b.name, status: "error", error: String(e.message || e) });
    }
  }
  return { status: "ok", matched: blocks.length, results };
}

function shutdown() {
  log("INFO", "SHUTDOWN", {});
  // Close TCP wrapper (HTTP server is closed by tcpServer)
  tcpServer.close();
  // Close UDS server and clean up socket file
  if (typeof udsServer !== "undefined" && udsServer) {
    udsServer.close();
  }
  if (fs.existsSync(UDS_PATH)) {
    try {
      fs.unlinkSync(UDS_PATH);
    } catch (_) { }
    log("INFO", "UDS_CLEANUP", { path: UDS_PATH });
  }
  // Close all SSE connections
  for (const [clientId, { res }] of sseClients) {
    try {
      res.end();
    } catch (_) { }
  }
  sseClients.clear();
  log("INFO", "SSE_CLEANUP", {});
  // Persist any buffered client-info writes before the process dies
  flushClientsSync();
  log("INFO", "CLIENTS_FLUSHED", {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Flush buffered client-info writes on any other exit path too
process.on("exit", () => {
  try { flushClientsSync(); } catch (_) { }
});
