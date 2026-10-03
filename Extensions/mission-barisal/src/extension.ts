import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { AgentInfo, ChatMessage, ChatTool, GatewayClient } from "./gateway";

const PARTICIPANT_ID = "mission-barisal.mission";
const MCP_PROVIDER_ID = "mission-barisal.mcp";
const API_KEY_SECRET = "missionBarisal.apiKey";
const DEFAULT_GATEWAY = "https://zombiecoder.my.id";
const DEFAULT_LOCAL_GATEWAY = "http://127.0.0.1:5000";
const DEFAULT_SOCKET = "/tmp/zombiecoder/mcp.sock";

function config() {
  const settings = vscode.workspace.getConfiguration("missionBarisal");
  return {
    gatewayUrl: settings.get<string>("gatewayUrl", DEFAULT_GATEWAY),
    localGatewayUrl: settings.get<string>("localGatewayUrl", DEFAULT_LOCAL_GATEWAY),
    mcpSocketPath: settings.get<string>("mcpSocketPath", DEFAULT_SOCKET),
    preferUds: settings.get<boolean>("preferUds", true),
    timeoutMs: settings.get<number>("requestTimeoutMs", 500000),
    agentId: settings.get<string>("agentId", "bug-hunter"),
  };
}

async function client(context: vscode.ExtensionContext, agentId?: string): Promise<GatewayClient> {
  const settings = config();
  const apiKey = await context.secrets.get(API_KEY_SECRET);
  return new GatewayClient({
    baseUrl: settings.gatewayUrl,
    localBaseUrl: settings.localGatewayUrl,
    socketPath: settings.mcpSocketPath,
    preferUds: settings.preferUds,
    timeoutMs: settings.timeoutMs,
    apiKey,
    metadata: {
      "x-agent-id": agentId || "mission-barisal-vscode",
      "x-device-info": `Visual Studio Code ${vscode.version} (${process.platform}/${process.arch})`,
      "x-editor-version": vscode.version,
      "x-os-platform": process.platform,
      "x-client-version": "0.1.3",
    },
  });
}

function cancellation(token: vscode.CancellationToken): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  if (token.isCancellationRequested) controller.abort();
  return { signal: controller.signal, dispose: () => subscription.dispose() };
}

function contentText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content.map((part) => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (part instanceof vscode.LanguageModelToolCallPart) {
      return `[Previous tool call: ${part.name} ${JSON.stringify(part.input)}]`;
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
      return part.content.map((item) => item instanceof vscode.LanguageModelTextPart ? item.value : "").join("\n");
    }
    return "";
  }).filter(Boolean).join("\n");
}

function requestRole(message: vscode.LanguageModelChatRequestMessage): ChatMessage["role"] {
  if (message.role === vscode.LanguageModelChatMessageRole.User) return "user";
  if (message.role === vscode.LanguageModelChatMessageRole.Assistant) return "assistant";
  return "system";
}

function gatewayTools(tools: readonly vscode.LanguageModelChatTool[] | undefined): ChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.inputSchema || { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

class MissionLanguageModelProvider implements vscode.LanguageModelChatProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const cancel = cancellation(token);
    try {
      const agents = await (await client(this.context)).listAgents(cancel.signal);
      return agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        family: agent.role || "mission-barisal-agent",
        version: "1.0.0",
        maxInputTokens: 4096,
        maxOutputTokens: 1024,
        detail: `Mission Barisal · ${agent.role || "agent"}`,
        tooltip: `Persona and tools are orchestrated by the Mission Barisal gateway (${agent.id}).`,
        capabilities: { imageInput: false, toolCalling: true },
      }));
    } catch (error) {
      if (!options.silent) {
        const message = error instanceof Error ? error.message : "Gateway unavailable";
        void vscode.window.showErrorMessage(`Mission Barisal could not load agents: ${message}`);
      }
      return [];
    } finally {
      cancel.dispose();
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const cancel = cancellation(token);
    try {
      const chatMessages = messages
        .filter((message) => String(message.role) !== "system")
        .slice(-16)
        .map((message) => ({
        role: requestRole(message),
        content: contentText(message),
        }));
      if (!chatMessages.some((message) => message.role === "user")) {
        throw new Error("Copilot did not provide a user message for the selected agent");
      }
      const tools = gatewayTools(options.tools);
      const toolChoice = tools?.length && options.toolMode === vscode.LanguageModelChatToolMode.Required
        ? "required"
        : undefined;
      const response = await (await client(this.context, model.id)).completeAgent(
        model.id,
        chatMessages,
        cancel.signal,
        tools,
        toolChoice,
      );
      progress.report(new vscode.LanguageModelTextPart(response));
    } finally {
      cancel.dispose();
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const value = typeof text === "string" ? text : contentText(text);
    return Math.ceil(value.length / 4);
  }
}

function chatHistory(context: vscode.ChatContext, prompt: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of context.history.slice(-10)) {
    if (turn instanceof vscode.ChatRequestTurn && turn.prompt) {
      messages.push({ role: "user", content: turn.prompt });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const response = turn.response.map((part) => {
        const value = (part as { value?: unknown }).value;
        if (typeof value === "string") return value;
        if (value && typeof value === "object" && "value" in value) {
          return String((value as { value: unknown }).value);
        }
        return "";
      }).filter(Boolean).join("\n");
      if (response) messages.push({ role: "assistant", content: response });
    }
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

async function chooseAgent(context: vscode.ExtensionContext): Promise<AgentInfo | undefined> {
  const agents = await (await client(context)).listAgents();
  const selected = await vscode.window.showQuickPick(agents.map((agent) => ({
    label: agent.name,
    description: agent.role || agent.id,
    detail: agent.id,
    agent,
  })), { placeHolder: "Choose a Mission Barisal agent" });
  if (selected) {
    await vscode.workspace.getConfiguration("missionBarisal").update(
      "agentId", selected.agent.id, vscode.ConfigurationTarget.Workspace,
    );
    return selected.agent;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MissionLanguageModelProvider(context);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("mission-barisal", provider),
  );

  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
    async provideMcpServerDefinitions(): Promise<vscode.McpServerDefinition[]> {
      const settings = config();
      const serverPath = context.asAbsolutePath(path.join("out", "mcp-stdio.js"));
      return [new vscode.McpStdioServerDefinition(
        "Mission Barisal Gateway",
        process.execPath,
        [serverPath],
        {
          MISSION_BARISAL_GATEWAY_URL: settings.gatewayUrl,
          MISSION_BARISAL_LOCAL_GATEWAY_URL: settings.localGatewayUrl,
          MISSION_BARISAL_MCP_SOCKET: settings.mcpSocketPath,
          MISSION_BARISAL_PREFER_UDS: String(settings.preferUds),
          MISSION_BARISAL_TIMEOUT_MS: String(settings.timeoutMs),
          VSCODE_VERSION: vscode.version,
        },
        "0.1.4",
      )];
    },
    async resolveMcpServerDefinition(server: vscode.McpServerDefinition): Promise<vscode.McpServerDefinition> {
      if (server instanceof vscode.McpStdioServerDefinition) {
        server.env = {
          ...server.env,
          MISSION_BARISAL_API_KEY: await context.secrets.get(API_KEY_SECRET) || null,
        };
      }
      return server;
    },
  }));

  context.subscriptions.push(vscode.chat.createChatParticipant(PARTICIPANT_ID, async (request, chatContext, stream, token) => {
    if (request.command === "agents") {
      try {
        const selected = await chooseAgent(context);
        if (selected) stream.markdown(`Agent selected: **${selected.name}** (${selected.id}).`);
      } catch (error) {
        stream.markdown(`Could not load agents: ${error instanceof Error ? error.message : "gateway unavailable"}`);
      }
      return;
    }

    const agentId = config().agentId;
    const cancel = cancellation(token);
    try {
      if (request.command === "status") {
        const health = await (await client(context)).health(cancel.signal);
        stream.markdown(`Gateway is healthy. ${String(health.agents || 0)} agents are available at ${config().gatewayUrl}.`);
        return;
      }
      stream.progress(`Asking ${agentId}...`);
      const messages = chatHistory(chatContext, request.prompt);
      const response = await (await client(context, agentId)).completeAgent(agentId, messages, cancel.signal);
      stream.markdown(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Gateway request failed";
      stream.markdown(`Mission Barisal request failed: ${message}`);
    } finally {
      cancel.dispose();
    }
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand("mission-barisal.selectAgent", () => chooseAgent(context)),
    vscode.commands.registerCommand("mission-barisal.configure", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:zombiecoder.mission-barisal-vscode missionBarisal"),
    ),
    vscode.commands.registerCommand("mission-barisal.testConnection", async () => {
      try {
        const gateway = await client(context);
        const [health, agents] = await Promise.all([gateway.health(), gateway.listAgents()]);
        const message = `Mission Barisal connected: ${agents.length} agents, ${String(health.version || "unknown")}.`;
        void vscode.window.showInformationMessage(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gateway unavailable";
        void vscode.window.showErrorMessage(`Mission Barisal connection failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand("mission-barisal.setApiKey", async () => {
      const value = await vscode.window.showInputBox({
        prompt: "Gateway API key (leave empty to use anonymous access)",
        password: true,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      if (value.trim()) await context.secrets.store(API_KEY_SECRET, value.trim());
      else await context.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage("Mission Barisal credential updated.");
    }),
  );
}

export function deactivate(): void {}
