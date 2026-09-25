/**
 * Agent Loader — Mission Barisal v3
 * Loads individual agent/*.js files and merges with DB/PERSONAS.md
 *
 * Priority order:
 *   1. SQLite DB (MODELS_DB) — runtime admin edits
 *   2. agent/*.js files — this module (fallback defaults)
 *   3. PERSONAS.md — markdown format (legacy fallback)
 *   4. .zombiecoder/agents/*.md — custom YAML frontmatter
 *   5. DEFAULT_AGENTS — hardcoded minimal fallback
 *
 * Zero external dependencies. Pure Node.js fs + path.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * Load all agent config files from this directory (agent/*.js)
 * Returns sorted array of agent objects.
 * If loading fails, returns empty array (safe fallback).
 */
function loadAgentFiles() {
  const agentsDir = __dirname;
  const agents = [];

  try {
    const files = fs.readdirSync(agentsDir).filter((f) => {
      return (
        f.endsWith(".js") &&
        f !== "index.js" &&
        !f.startsWith(".") &&
        !f.startsWith("_")
      );
    });

    for (const file of files) {
      try {
        const agentPath = path.join(agentsDir, file);
        
        // 1. Read file content as raw string
        let code = fs.readFileSync(agentPath, 'utf8');
        
        // 2. Remove BOM (Byte Order Mark) if present at the very start
        if (code.charCodeAt(0) === 0xFEFF) {
          code = code.slice(1);
        }

        // 3. Execute the code in a sandboxed context to extract exports
        // This avoids require() caching issues and parses clean string directly
        const sandbox = {
          module: { exports: {} },
          exports: {},
          require: require, // Allow requiring other modules if needed inside agent files
          __filename: agentPath,
          __dirname: agentsDir
        };

        vm.runInNewContext(code, sandbox, { filename: file, displayErrors: true });

        const agent = sandbox.module.exports || sandbox.exports;

        // Validate: must have id and persona
        if (agent && agent.id && agent.persona) {
          agents.push({
            id: agent.id,
            name: agent.name || agent.id,
            model: agent.model || "nemotron-3-ultra-free",
            role: agent.role || "general",
            expertise: agent.expertise || "",
            priority: parseInt(agent.priority || "99", 10),
            enabled: agent.enabled !== undefined ? (agent.enabled ? 1 : 0) : 1,
            persona: agent.persona,
            mission: agent.mission || "",
            decisionRule: agent.decisionRule || "",
            corePersona: agent.corePersona || "",
            tags: agent.tags || [],
            source: "agent/*.js",
          });
        } else {
           console.warn(`[AGENT_LOADER] Invalid agent structure in ${file}`);
        }
      } catch (e) {
        // Skip individual file errors — never crash the loader
        console.error(`[AGENT_LOADER] Skip ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[AGENT_LOADER] Directory read failed: ${e.message}`);
  }

  // Sort by priority (lower = higher priority)
  agents.sort((a, b) => (a.priority || 99) - (b.priority || 99));

  return agents;
}

/**
 * Get a single agent config by ID from file system.
 * Returns agent object or null if not found.
 */
function getAgentById(agentId) {
  const filePath = path.join(__dirname, `${agentId}.js`);
  if (fs.existsSync(filePath)) {
    try {
      delete require.cache[require.resolve(filePath)];
      return require(filePath);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * Get all agent IDs from file system.
 */
function listAgentIds() {
  try {
    return fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".js") && f !== "index.js" && !f.startsWith(".") && !f.startsWith("_"))
      .map((f) => f.replace(".js", ""));
  } catch (e) {
    return [];
  }
}

module.exports = {
  loadAgentFiles,
  getAgentById,
  listAgentIds,
};
