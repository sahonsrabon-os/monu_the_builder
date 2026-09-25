// =============================================================================
// Mission Barisal v3 — MCP Client Manager
// Connect to external MCP servers and proxy their tools
// Industry Standard: JSON-RPC 2.0 over HTTP/SSE/Streamable HTTP
// =============================================================================

const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(
  process.env.MCP_CLIENTS_FILE || "./data/mcp-clients.json",
);
const DEFAULT_TIMEOUT = 30000;

class MCPClientManager {
  constructor(logFn) {
    this.log = logFn || console.log;
    this.servers = new Map(); // name -> { url, name, status, tools, lastSeen, transport }
    this._loadConfig();
  }

  // ─── Config Persistence ────────────────────────────────────
  _loadConfig() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        if (data.servers && Array.isArray(data.servers)) {
          for (const s of data.servers) {
            this.servers.set(s.name, {
              name: s.name,
              url: s.url,
              transport: s.transport || "http",
              status: "disconnected",
              tools: [],
              lastSeen: null,
              error: null,
              token: s.token || null,
              autoConnect: s.autoConnect !== false,
            });
          }
          this.log("INFO", "MCP_CLIENTS_LOADED", {
            count: this.servers.size,
            source: "file",
          });
        }
      }
    } catch (e) {
      this.log("WARN", "MCP_CLIENTS_LOAD_FAIL", { error: e.message });
    }

    // Load servers from MCP_ADD_N environment variables.
    // Format: MCP_ADD_1=name|url  or  MCP_ADD_1=name|url|token
    // Environment entries are additive — they do not remove file-configured servers.
    try {
      let envCount = 0;
      for (const key of Object.keys(process.env)) {
        const m = key.match(/^MCP_ADD_(\d+)$/);
        if (!m) continue;
        const raw = (process.env[key] || "").trim();
        if (!raw) continue;
        const parts = raw.split("|");
        const name = (parts[0] || "").trim();
        let url = (parts[1] || "").trim();
        const token = parts.length > 2 ? parts[2].trim() : "";
        if (!name || !url) {
          this.log("WARN", "MCP_ADD_SKIPPED", { key, reason: "missing name or url" });
          continue;
        }
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          // Allow bare host:port -> http://host:port
          url = "http://" + url;
        }
        if (!url.endsWith("/mcp") && !/\/mcp$/.test(url)) {
          url = url.replace(/\/+$/, "") + "/mcp";
        }
        this.servers.set(name, {
          name,
          url,
          transport: "http",
          status: "disconnected",
          tools: [],
          lastSeen: null,
          error: null,
          token: token || null,
          autoConnect: true,
          source: "env:" + key,
        });
        envCount++;
      }
      if (envCount > 0) {
        this.log("INFO", "MCP_CLIENTS_ENV_LOADED", { count: envCount });
      }
    } catch (e) {
      this.log("WARN", "MCP_CLIENTS_ENV_FAIL", { error: e.message });
    }
  }

  _saveConfig() {
    try {
      const dir = path.dirname(CONFIG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data = {
        version: 1,
        servers: Array.from(this.servers.values())
          .filter((s) => !s.source || !s.source.startsWith("env:"))
          .map((s) => ({
            name: s.name,
            url: s.url,
            transport: s.transport,
            token: s.token,
            autoConnect: s.autoConnect,
          })),
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      this.log("WARN", "MCP_CLIENTS_SAVE_FAIL", { error: e.message });
    }
  }

  // ─── HTTP Request Helper ───────────────────────────────────
  _request(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const mod = isHttps ? https : http;

      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...options.headers,
      };

      if (options.token) {
        headers["Authorization"] = `Bearer ${options.token}`;
      }

      const req = mod.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || "POST",
          headers,
          timeout: options.timeout || DEFAULT_TIMEOUT,
          rejectUnauthorized: !options.insecure,
        },
        (res) => {
          let data = "";
          let isSSE = false;
          let sseData = [];

          // Check if response is SSE
          const contentType = res.headers["content-type"] || "";
          if (contentType.includes("text/event-stream")) {
            isSSE = true;
          }

          res.on("data", (chunk) => {
            if (isSSE) {
              // Parse SSE events
              const lines = chunk.toString().split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  const jsonData = line.slice(6).trim();
                  if (jsonData) {
                    try {
                      sseData.push(JSON.parse(jsonData));
                    } catch (e) {
                      // Not JSON, keep as text
                      sseData.push({ raw: jsonData });
                    }
                  }
                }
              }
            } else {
              data += chunk;
            }
          });

          res.on("end", () => {
            if (isSSE) {
              resolve({ status: res.statusCode, data: sseData, sse: true });
            } else {
              try {
                resolve({
                  status: res.statusCode,
                  data: JSON.parse(data || "{}"),
                  sse: false,
                });
              } catch (e) {
                resolve({ status: res.statusCode, data: { raw: data }, sse: false });
              }
            }
          });
        },
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      req.end();
    });
  }

  // ─── Connect to External MCP Server ────────────────────────
  async connectServer(name, url, options = {}) {
    if (this.servers.has(name)) {
      const existing = this.servers.get(name);
      // Already connected — return current status without re-running the flow.
      if (existing.status === "connected" && existing.tools.length > 0) {
        this.log("INFO", "MCP_CLIENT_ALREADY_CONNECTED", { name });
        return { success: true, tools: existing.tools.length, server: name };
      }
      // Registered but not connected — update endpoint and connect.
      existing.url = url || existing.url;
      if (options.token) existing.token = options.token;
      if (options.transport) existing.transport = options.transport;
      return this._doConnect(existing);
    }

    const server = {
      name,
      url,
      transport: options.transport || "http",
      status: "connecting",
      tools: [],
      lastSeen: null,
      error: null,
      token: options.token || null,
      autoConnect: options.autoConnect !== false,
    };

    this.servers.set(name, server);
    this._saveConfig();
    return this._doConnect(server);
  }

  // ─── Internal: perform the actual MCP handshake on a server ─
  async _doConnect(server) {
    const name = server.name;
    const url = server.url;
    server.status = "connecting";
    server.error = null;
    try {
      // Step 1: Initialize MCP connection
      const initResult = await this._request(url, {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            clientInfo: {
              name: "mission-barisal",
              version: "3.2.1",
            },
          },
        },
        token: server.token,
      });

      if (initResult.status !== 200) {
        throw new Error(
          `Initialize failed with status ${initResult.status}`,
        );
      }

      // Step 2: Send initialized notification
      await this._request(url, {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
        token: server.token,
      }).catch(() => {}); // Notifications don't expect response

      // Step 3: List tools
      const toolsResult = await this._request(url, {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        token: server.token,
      });

      if (toolsResult.status === 200 && toolsResult.data?.result?.tools) {
        server.tools = toolsResult.data.result.tools.map((t) => ({
          name: t.name,
          description: t.description || "",
          inputSchema: t.inputSchema || { type: "object", properties: {} },
          source: name, // Tag with source server
        }));
      }

      server.status = "connected";
      server.lastSeen = new Date().toISOString();
      server.error = null;

      this.log("INFO", "MCP_CLIENT_CONNECTED", {
        name,
        url,
        tools: server.tools.length,
      });

      this._saveConfig();
      return { success: true, tools: server.tools.length, server: name };
    } catch (err) {
      server.status = "error";
      server.error = err.message;

      this.log("WARN", "MCP_CLIENT_CONNECT_FAIL", {
        name,
        url,
        error: err.message,
      });

      this._saveConfig();
      return { success: false, error: err.message, server: name };
    }
  }

  // ─── Reconnect to a Server ─────────────────────────────────
  async reconnectServer(name) {
    const server = this.servers.get(name);
    if (!server) return { success: false, error: "Server not found" };
    if (!server.url) return { success: false, error: "Server has no url" };
    return this._doConnect(server);
  }

  // ─── Disconnect from a Server ──────────────────────────────
  disconnectServer(name) {
    const server = this.servers.get(name);
    if (!server) return { success: false, error: "Server not found" };

    server.status = "disconnected";
    server.tools = [];
    this._saveConfig();

    this.log("INFO", "MCP_CLIENT_DISCONNECTED", { name });
    return { success: true, server: name };
  }

  // ─── Remove a Server ───────────────────────────────────────
  removeServer(name) {
    if (!this.servers.has(name)) {
      return { success: false, error: "Server not found" };
    }
    this.servers.delete(name);
    this._saveConfig();
    this.log("INFO", "MCP_CLIENT_REMOVED", { name });
    return { success: true, server: name };
  }

  // ─── List All External Tools ───────────────────────────────
  getAllExternalTools() {
    const allTools = [];
    for (const [name, server] of this.servers) {
      if (server.status === "connected" && server.tools.length > 0) {
        for (const tool of server.tools) {
          allTools.push({
            ...tool,
            // Prefix tool name with server name to avoid conflicts
            fullName: `${name}__${tool.name}`,
            serverName: name,
          });
        }
      }
    }
    return allTools;
  }

  // ─── Call an External Tool ─────────────────────────────────
  async callExternalTool(serverName, toolName, args = {}) {
    const server = this.servers.get(serverName);
    if (!server) {
      return {
        content: [
          {
            type: "text",
            text: `Error: MCP server "${serverName}" not found`,
          },
        ],
      };
    }

    if (server.status !== "connected") {
      // Try to reconnect
      const reconnect = await this.reconnectServer(serverName);
      if (!reconnect.success) {
        return {
          content: [
            {
              type: "text",
              text: `Error: MCP server "${serverName}" is not connected: ${server.error || "unknown error"}. Reconnect failed.`,
            },
          ],
        };
      }
    }

    try {
      const result = await this._request(server.url, {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: toolName,
            arguments: args,
          },
        },
        token: server.token,
      });

      server.lastSeen = new Date().toISOString();

      if (result.status === 200 && result.data?.result) {
        return result.data.result;
      } else if (result.data?.error) {
        return {
          content: [
            {
              type: "text",
              text: `External tool error: ${result.data.error.message || JSON.stringify(result.data.error)}`,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: `External tool returned status ${result.status}: ${JSON.stringify(result.data).slice(0, 500)}`,
            },
          ],
        };
      }
    } catch (err) {
      server.status = "error";
      server.error = err.message;
      return {
        content: [
          {
            type: "text",
            text: `External tool call failed: ${err.message}`,
          },
        ],
      };
    }
  }

  // ─── Get Server Status ─────────────────────────────────────
  getServerStatus(name) {
    const server = this.servers.get(name);
    if (!server) return null;
    return {
      name: server.name,
      url: server.url,
      transport: server.transport,
      status: server.status,
      tools: server.tools.length,
      lastSeen: server.lastSeen,
      error: server.error,
    };
  }

  // ─── List All Servers ──────────────────────────────────────
  listServers() {
    return Array.from(this.servers.values()).map((s) => ({
      name: s.name,
      url: s.url,
      transport: s.transport,
      status: s.status,
      tools: s.tools.length,
      lastSeen: s.lastSeen,
      error: s.error,
    }));
  }

  // ─── Get single server status ──────────────────────────────
  getServerStatus(name) {
    const server = this.servers.get(name);
    if (!server) return null;
    return {
      name: server.name,
      url: server.url,
      transport: server.transport,
      status: server.status,
      tools: server.tools.map((t) => ({
        name: t.name,
        description: t.description,
      })),
      lastSeen: server.lastSeen,
      error: server.error,
      autoConnect: server.autoConnect,
    };
  }

  // ─── Auto-connect on startup ───────────────────────────────
  async autoConnectAll() {
    const results = [];
    for (const [name, server] of this.servers) {
      if (server.autoConnect && server.url) {
        const result = await this.connectServer(name, server.url, {
          transport: server.transport,
          token: server.token,
        });
        results.push({ name, ...result });
      }
    }
    return results;
  }

  // ─── Parse tool name (server__tool -> server, tool) ────────
  parseExternalToolName(fullName) {
    const idx = fullName.indexOf("__");
    if (idx === -1) return { serverName: null, toolName: fullName };
    return {
      serverName: fullName.slice(0, idx),
      toolName: fullName.slice(idx + 2),
    };
  }

  // ─── Check if a tool name is external ──────────────────────
  isExternalTool(toolName) {
    return toolName.includes("__") && this.servers.has(toolName.split("__")[0]);
  }
}

module.exports = { MCPClientManager };
