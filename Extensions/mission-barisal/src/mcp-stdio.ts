import { createInterface } from "node:readline";
import { GatewayClient, JsonRpcRequest } from "./gateway";

const client = new GatewayClient({
  baseUrl: process.env.MISSION_BARISAL_GATEWAY_URL || "https://zombiecoder.my.id",
  localBaseUrl: process.env.MISSION_BARISAL_LOCAL_GATEWAY_URL || "http://127.0.0.1:5000",
  socketPath: process.env.MISSION_BARISAL_MCP_SOCKET || "/tmp/zombiecoder/mcp.sock",
  preferUds: process.env.MISSION_BARISAL_PREFER_UDS !== "false",
  timeoutMs: Number(process.env.MISSION_BARISAL_TIMEOUT_MS) || 500000,
  apiKey: process.env.MISSION_BARISAL_API_KEY || undefined,
  metadata: {
    "x-device-info": `VS Code MCP stdio/${process.platform}`,
    "x-editor-version": process.env.VSCODE_VERSION || "unknown",
    "x-os-platform": process.platform,
    "x-client-version": "0.1.4",
  },
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

function writeError(id: unknown, message: string): void {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32000, message },
  }) + "\n");
}

async function run(): Promise<void> {
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      writeError(null, "Invalid JSON-RPC request");
      continue;
    }

    void client.sendRpc(request).then((response) => {
      if (request.id !== undefined && request.id !== null) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "MCP transport failed";
      if (request.id !== undefined && request.id !== null) writeError(request.id, message);
      else process.stderr.write(`[mission-barisal] ${message}\n`);
    });
  }
}

void run();
