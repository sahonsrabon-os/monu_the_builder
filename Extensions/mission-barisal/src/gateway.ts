import * as fs from "node:fs";
import * as net from "node:net";

export interface AgentInfo {
  id: string;
  name: string;
  role?: string;
  model?: string;
  enabled?: boolean | number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ChatToolChoice = "auto" | "required";

export interface GatewayConfig {
  baseUrl: string;
  localBaseUrl?: string;
  socketPath: string;
  preferUds: boolean;
  timeoutMs: number;
  apiKey?: string;
  metadata?: Record<string, string>;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly localBaseUrl: string;
  private nextId = 1;

  constructor(private readonly config: GatewayConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.localBaseUrl = (config.localBaseUrl || "").replace(/\/+$/, "");
  }

  async listAgents(signal?: AbortSignal): Promise<AgentInfo[]> {
    const response = await this.gatewayJson("/api/agents", signal);
    const agents = Array.isArray(response.agents) ? response.agents : [];
    return agents.filter((agent: AgentInfo) => agent && agent.id && agent.enabled !== false && agent.enabled !== 0);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.gatewayJson("/health", signal);
  }

  async callAgent(agentId: string, input: string, signal?: AbortSignal): Promise<string> {
    const response = await this.sendRpc({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: {
        name: "agent_single",
        arguments: { agent_id: agentId, input },
      },
    }, signal);

    if (response.error) {
      throw new Error(response.error.message || "Gateway agent call failed");
    }

    const result = response.result?.result || response.result;
    const text = this.extractText(result?.content);
    if (text) return text;
    if (result?.structuredContent) return JSON.stringify(result.structuredContent);
    throw new Error("Gateway agent returned an empty response");
  }

  async completeAgent(
    agentId: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ChatTool[],
    toolChoice?: ChatToolChoice,
  ): Promise<string> {
    const sessionId = `vscode-${this.nextId}-${Date.now()}`;
    if (this.config.preferUds && this.config.socketPath && fs.existsSync(this.config.socketPath)) {
      const request = {
        type: "chat_completion",
        id: this.nextId++,
        model: agentId,
        agent_id: agentId,
        session_id: sessionId,
        client_id: "mission-barisal-vscode",
        editor: "vscode",
        metadata: this.config.metadata || {},
        messages,
        tools,
        tool_choice: toolChoice,
      };
      try {
        const response = await this.sendUds(request as unknown as JsonRpcRequest, signal);
        return this.readCompletion(response as any);
      } catch (error) {
        if ((error as Error & { requestSent?: boolean }).requestSent) throw error;
      }
    }

    const response = await this.gatewayJson("/v1/chat/completions", signal, {
      method: "POST",
      body: JSON.stringify({
        model: agentId,
        messages,
        session_id: sessionId,
        stream: false,
        ...(tools?.length ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      }),
      headers: this.headers(agentId),
    });
    return this.readCompletion(response);
  }

  async sendRpc(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    if (this.config.preferUds && this.config.socketPath && fs.existsSync(this.config.socketPath)) {
      try {
        return await this.sendUds(request, signal);
      } catch (error) {
        if ((error as Error & { requestSent?: boolean }).requestSent) throw error;
      }
    }
    return this.sendHttpRpc(request, signal);
  }

  private async sendUds(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.config.socketPath });
      let buffer = "";
      let sent = false;
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new Error("MCP UDS request timed out"));
      }, this.config.timeoutMs);
      const abort = () => fail(new Error("MCP UDS request cancelled"));

      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        socket.removeAllListeners();
        socket.destroy();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        Object.assign(error, { requestSent: sent });
        cleanup();
        reject(error);
      };

      if (signal?.aborted) {
        fail(new Error("MCP UDS request cancelled"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        sent = true;
        socket.write(JSON.stringify(request) + "\n");
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > 8 * 1024 * 1024) {
          fail(new Error("MCP UDS response exceeded the size limit"));
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          try {
            const response = JSON.parse(line) as JsonRpcResponse;
            if (request.id !== undefined && response.id !== request.id) continue;
            if (settled) return;
            settled = true;
            cleanup();
            resolve(response);
            return;
          } catch {
            fail(new Error("Invalid JSON-RPC response from MCP UDS"));
            return;
          }
        }
      });
      socket.once("error", (error) => fail(error));
      socket.once("end", () => {
        if (!settled) fail(new Error("MCP UDS closed before replying"));
      });
    });
  }

  private async sendHttpRpc(request: JsonRpcRequest, signal?: AbortSignal): Promise<JsonRpcResponse> {
    return this.gatewayJson("/mcp", signal, {
      method: "POST",
      body: JSON.stringify(request),
      headers: this.headers("mission-barisal-vscode"),
    });
  }

  private async gatewayJson(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<any> {
    if (this.localBaseUrl && this.localBaseUrl !== this.baseUrl) {
      try {
        return await this.fetchJson(this.localBaseUrl + path, signal, init);
      } catch (error) {
        if (!this.isConnectionError(error)) throw error;
      }
    }
    return this.fetchJson(this.baseUrl + path, signal, init);
  }

  private isConnectionError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const causeCode = (error as Error & { cause?: { code?: string } }).cause?.code || "";
    return error instanceof TypeError || /ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH/.test(causeCode);
  }

  private async fetchJson(url: string, signal?: AbortSignal, init: RequestInit = {}): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { ...this.headers("mission-barisal-vscode"), ...init.headers },
      });
      const text = await response.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Gateway returned invalid JSON (HTTP ${response.status})`);
      }
      if (!response.ok) {
        throw new Error(data?.error?.message || `Gateway returned HTTP ${response.status}`);
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(signal?.aborted ? "Gateway request cancelled" : "Gateway request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  private headers(agentId: string): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "mission-barisal-vscode/0.1.3",
      "x-agent-id": agentId,
      ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
      ...(this.config.metadata || {}),
    };
  }

  private extractText(content: unknown): string {
    if (!Array.isArray(content)) return typeof content === "string" ? content : "";
    return content
      .filter((part) => part && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
  }

  private readCompletion(response: any): string {
    if (response?.error) {
      throw new Error(response.error.message || "Gateway chat completion failed");
    }
    const message = response?.choices?.[0]?.message;
    if (typeof message?.content === "string" && message.content.trim()) {
      return message.content;
    }
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      throw new Error("Gateway returned unfinished tool calls instead of an agent response");
    }
    throw new Error("Gateway returned an empty chat completion");
  }
}
