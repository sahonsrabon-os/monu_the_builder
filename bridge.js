#!/usr/bin/env node
// =============================================================================
// Mission Barisal - bridge.js (Caddy replacement, zero dependency)
// -----------------------------------------------------------------------------
// Listens on 127.0.0.1:9999 and forwards HTTP/SSE/WebSocket to the Engine on
// 127.0.0.1:5000 (PORT from engine .env). Editors connect to localhost:9999
// exactly like the Caddy reverse_proxy described in doc/Server-Sent Events.md.
//
// Why: Windows has no Caddy installed, and editors prefer a plain HTTP URL
// over the Engine's raw TCP MCP socket (5001) / UDS socket.
//
// Usage:
//   node bridge.js                     # listen 9999 -> 127.0.0.1:5000
//   BRIDGE_PORT=9998 node bridge.js    # different listen port
//   BRIDGE_TARGET_PORT=5000 node bridge.js
//
// Features:
//   - Full HTTP passthrough (headers, body, status) - streaming safe
//   - SSE (text/event-stream) piped untouched - no buffering
//   - WebSocket upgrade forwarding (engine's /ws endpoint)
// =============================================================================
const http = require("http");
const net = require("net");

const LISTEN_HOST = process.env.BRIDGE_LISTEN_HOST || "127.0.0.1";
// BRIDGE_PROXY_PORT is the unambiguous key. BRIDGE_PORT is kept for backward
// compatibility BUT it is shared with local-llm-bridge.js (whose default is
// 11435) — if a shell export carries that meaning here, listening on it would
// collide with the LLM bridge, so fall back to the real proxy default 9999.
const LEGACY_PORT = parseInt(process.env.BRIDGE_PORT || "9999", 10);
const LISTEN_PORT = parseInt(
  process.env.BRIDGE_PROXY_PORT || (LEGACY_PORT === 11435 ? "9999" : String(LEGACY_PORT)),
  10,
);
const TARGET_HOST = process.env.BRIDGE_TARGET_HOST || "127.0.0.1";
const TARGET_PORT = parseInt(process.env.BRIDGE_TARGET_PORT || "5000", 10);

if (LISTEN_PORT === TARGET_PORT) {
  console.error(
    `[bridge] refusing to start: listen port ${LISTEN_PORT} === target port ${TARGET_PORT} (proxy would loop into itself)`,
  );
  process.exit(1);
}

const log = (...args) => console.log(`[bridge] ${new Date().toISOString()}`, ...args);

// ---- HTTP proxy (handles SSE streaming - response piped as-is) ----
const server = http.createServer((req, res) => {
  const proxyReq = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${TARGET_HOST}:${TARGET_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`[bridge] upstream error: ${err.message}`);
  });
  req.pipe(proxyReq);
});

// ---- WebSocket / raw upgrade forwarding ----
server.on("upgrade", (req, socket, head) => {
  const proxySocket = net.connect(TARGET_PORT, TARGET_HOST, () => {
    proxySocket.write(
      [
        `${req.method} ${req.url} HTTP/1.1`,
        ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ].join("\r\n")
    );
    if (head && head.length) proxySocket.write(head);
  });
  proxySocket.on("error", () => socket.destroy());
  socket.on("error", () => proxySocket.destroy());
  socket.pipe(proxySocket);
  proxySocket.pipe(socket);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`listening http://${LISTEN_HOST}:${LISTEN_PORT} -> http://${TARGET_HOST}:${TARGET_PORT}`);
});

process.on("SIGINT", () => { server.close(() => process.exit(0)); });
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });