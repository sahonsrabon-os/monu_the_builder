# MCP Tools — Mission Barisal (26)

Generated from `GET /api/admin/tools` on the live server. Machine-readable
OpenAI function-calling conversion: [`openai-schema.json`](openai-schema.json).
Regenerate after adding/removing tools: `node tools/gen-openai-docs.js`.

| # | Tool | Description | Enabled | Calls | Errors |
|---|------|-------------|---------|-------|--------|
| 1 | `agent_mission` | Execute a mission with all agents in parallel | Y | 0 | 0 |
| 2 | `agent_single` | Execute with a single agent | Y | 15 | 0 |
| 3 | `append_syllabus` | Append a knowledge entry to the project syllabus.md — the shared learning log ALL agents read (append-only; never overwrites). Use when you learn something new worth keeping. | Y | 5 | 0 |
| 4 | `browse_cdp` | Headless-browse a URL via Chrome DevTools Protocol over a PIPE (zero HTTP control channel — no port, no websocket). Fetches a page with headless Chrome and returns its text, HTML, title, or a screenshot. Use for reading local or remote web pages. | Y | 0 | 0 |
| 5 | `call_agent` | Call another agent for a specific sub-task. Use when the task needs specialized knowledge from another agent (e.g., security review, bug hunting, performance tuning). | Y | 0 | 0 |
| 6 | `db_list_tables` | List tables in the configured database (MySQL/SQLite/PostgreSQL). Config from env vars ONLY (DB_*). Cross-platform. | Y | 1 | 0 |
| 7 | `db_query` | Run a SQL query against a configured database (MySQL/SQLite/PostgreSQL). Config comes from env vars ONLY (DB_TYPE, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SQLITE_PATH, DB_TIMEOUT, PHP_BIN). MySQL/PostgreSQL use a PHP PDO bridge (db-bridge.php); SQLite uses Node built-in node:sqlite. Cross-platform (Windows/Linux/macOS). | Y | 1 | 0 |
| 8 | `delete_file` | Delete a file or directory (recursive for directories) | Y | 0 | 0 |
| 9 | `env_get` | Read an environment variable by name. Config is env-driven (never hardcoded). Values of KEY/SECRET/PASSWORD/TOKEN/AUTH variables are hidden unless reveal_secrets=true. | Y | 1 | 0 |
| 10 | `exec` | Run a shell command cross-platform in any folder. Windows uses PowerShell, Linux/macOS uses bash (override via EXEC_SHELL_WIN / EXEC_SHELL_LINUX env). Config from env vars ONLY (EXEC_SHELL_WIN, EXEC_SHELL_LINUX, EXEC_TIMEOUT, EXEC_MAX_BUFFER). | Y | 147 | 0 |
| 11 | `get_memory` | Retrieve session memory | Y | 0 | 0 |
| 12 | `get_working_dir` | Get current MCP working directory | Y | 7 | 0 |
| 13 | `glob` | Find files by glob pattern inside the MCP working dir (e.g. '**/*.{js,ts}') | Y | 1 | 0 |
| 14 | `grep` | Search file contents with a regex or plain text pattern inside the MCP working dir (bounded depth). Returns matching file paths + line snippets. | Y | 0 | 0 |
| 15 | `http_request` | Make an HTTP request (GET/POST/PUT/PATCH/DELETE) using Node built-in http/https. No external deps. Config: HTTP_TIMEOUT env (ms). Cross-platform. | Y | 0 | 0 |
| 16 | `list_directory` | List contents of a directory | Y | 2 | 0 |
| 17 | `open_browser` | Open a file or URL in the default browser (uses xdg-open/open/start) | Y | 0 | 0 |
| 18 | `read_file` | Read a file from the filesystem | Y | 3 | 0 |
| 19 | `read_ssot` | Read the current SSOT.md (Single Source of Truth) file — contains auto-detected project info | Y | 2 | 0 |
| 20 | `remote_mcp_call` | Call a tool on a remote MCP server (outbound MCP client). Use this to invoke tools exposed by connected remote MCP servers. | Y | 0 | 0 |
| 21 | `rename_file` | Rename or move a file/directory | Y | 0 | 0 |
| 22 | `set_working_dir` | Set MCP working directory for relative file paths | Y | 0 | 0 |
| 23 | `system_info` | Get cross-platform system info: platform, arch, OS, hostname, Node version, cwd, uptime, memory, non-secret env var names, and the configured DB config (values masked). | Y | 2 | 0 |
| 24 | `terminal` | Run a shell command in the server terminal (cwd = MCP working dir). Returns stdout/stderr/exit code. Windows: PowerShell 5.1; Linux/macOS: bash. | Y | 0 | 0 |
| 25 | `web_search` | Search the web for real-time information | Y | 3 | 0 |
| 26 | `write_file` | Write content to a file (creates directories) | Y | 0 | 0 |

_Total: 26 tools (gateway + external). Toggles are live: disabling a tool removes it from_
`tools/list` _and refuses_ `tools/call` _at the execution choke point. Call/error_
_counters are runtime stats — a snapshot at generation time._
