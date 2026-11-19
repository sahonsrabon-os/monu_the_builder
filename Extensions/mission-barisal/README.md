# Mission Barisal for VS Code

A single VS Code extension that exposes Mission Barisal agents in the model picker and as `@mission`, and registers the gateway's MCP tools for Copilot Chat.

## Connection

- Agent chat is routed through the Mission Barisal gateway, which owns personas, SSOT, syllabus, and server-side tool orchestration.
- MCP calls prefer `/tmp/zombiecoder/mcp.sock` on Linux/macOS.
- If the socket is unavailable, the extension uses HTTPS `POST /mcp` at the configured gateway URL. Windows uses this fallback.
- The Ollama bridge socket (`/tmp/local-llm.sock`) is not used as an MCP endpoint.

## Settings

- `missionBarisal.gatewayUrl`: defaults to `https://zombiecoder.my.id`.
- `missionBarisal.localGatewayUrl`: loopback HTTP (`http://127.0.0.1:5000`) tried before the tunnel when UDS is unavailable.
- `missionBarisal.mcpSocketPath`: defaults to `/tmp/zombiecoder/mcp.sock`.
- `missionBarisal.preferUds`: use the local socket before HTTPS.
- `missionBarisal.agentId`: default agent, initially `bug-hunter`.
- `missionBarisal.requestTimeoutMs`: maximum agent request duration.

Use **Mission Barisal: Set API Credential** to store an optional gateway API key in VS Code SecretStorage. The extension sends API metadata headers on HTTP requests; it does not invent an unsupported signature scheme. Local UDS requests rely on the operating-system socket permissions.

## Build

```sh
npm install
npm run check
npm run compile
npm run package
```

Install the resulting `.vsix` using **Extensions: Install from VSIX...**.
