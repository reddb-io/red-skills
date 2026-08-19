import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const HERMES_CHANNEL_BRIDGE_TOOLS = [
  "conversations_list",
  "conversation_get",
  "messages_read",
  "attachments_fetch",
  "events_poll",
  "events_wait",
  "messages_send",
  "channels_list",
  "permissions_list_open",
  "permissions_respond",
] as const;

export const HERMES_CHANNEL_BRIDGE_TOOL_MAP = {
  poll: ["events_poll"],
  send: ["messages_send"],
  channels: ["channels_list"],
  bridgeContract: HERMES_CHANNEL_BRIDGE_TOOLS,
} as const;

export type HermesChannelBridgeTool = (typeof HERMES_CHANNEL_BRIDGE_TOOLS)[number];

export interface ChannelBridgeProcess {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stderr?: StdioServerParameters["stderr"];
}

export interface ChannelBridgePollInput {
  afterCursor?: number | string;
  sessionKey?: string;
  limit?: number;
}

export interface ChannelEvent {
  id?: string;
  cursor?: number | string;
  type?: string;
  platform?: string;
  target?: string;
  sessionKey?: string;
  timestamp?: string;
  message?: string;
  raw: unknown;
}

export interface ChannelBridgePollResult {
  events: ChannelEvent[];
  nextCursor?: number | string;
  raw: unknown;
}

export interface ChannelTarget {
  target: string;
  platform?: string;
  name?: string;
  raw: unknown;
}

export interface ChannelBridgeChannelsInput {
  platform?: string;
}

export interface ChannelBridgeChannelsResult {
  channels: ChannelTarget[];
  raw: unknown;
}

export interface ChannelBridgeSendResult {
  ok: boolean;
  target: string;
  messageId?: string;
  raw: unknown;
}

export interface ChannelBridge {
  poll(input?: ChannelBridgePollInput): Promise<ChannelBridgePollResult>;
  send(target: string, message: string): Promise<ChannelBridgeSendResult>;
  channels(input?: ChannelBridgeChannelsInput): Promise<ChannelBridgeChannelsResult>;
  close(): Promise<void>;
}

export class McpStdioChannelBridge implements ChannelBridge {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;

  private constructor(client: Client, transport: StdioClientTransport) {
    this.client = client;
    this.transport = transport;
  }

  static async connect(processParams: ChannelBridgeProcess = {}): Promise<McpStdioChannelBridge> {
    const transport = new StdioClientTransport({
      command: processParams.command ?? "hermes",
      args: processParams.args ?? ["mcp", "serve"],
      cwd: processParams.cwd,
      env: processParams.env ?? safeProcessEnv(),
      stderr: processParams.stderr ?? "pipe",
    });
    const client = new Client({ name: "brain-channel-bridge", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const bridge = new McpStdioChannelBridge(client, transport);
      await bridge.assertHermesContract();
      return bridge;
    } catch (err) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw err;
    }
  }

  async poll(input: ChannelBridgePollInput = {}): Promise<ChannelBridgePollResult> {
    const raw = await this.callJson("events_poll", {
      after_cursor: input.afterCursor,
      session_key: input.sessionKey,
      limit: input.limit,
    });
    return {
      events: extractEvents(raw).map(normalizeEvent),
      nextCursor: firstCursor(raw, ["next_cursor", "nextCursor", "cursor"]),
      raw,
    };
  }

  async send(target: string, message: string): Promise<ChannelBridgeSendResult> {
    const raw = await this.callJson("messages_send", { target, message });
    const error = firstProperty(raw, ["error"]);
    return {
      ok: !error && firstBoolean(raw, ["ok", "success"], true),
      target,
      messageId: firstString(raw, ["message_id", "messageId", "id"]),
      raw,
    };
  }

  async channels(input: ChannelBridgeChannelsInput = {}): Promise<ChannelBridgeChannelsResult> {
    const raw = await this.callJson("channels_list", { platform: input.platform });
    return {
      channels: extractChannels(raw).map(normalizeChannel).filter((channel): channel is ChannelTarget => channel != null),
      raw,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close().catch(() => {});
  }

  private async assertHermesContract(): Promise<void> {
    const { tools } = await this.client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const missing = HERMES_CHANNEL_BRIDGE_TOOLS.filter((tool) => !names.has(tool));
    if (missing.length > 0) {
      throw new Error(`Hermes channel bridge is missing tool(s): ${missing.join(", ")}`);
    }
  }

  private async callJson(name: HermesChannelBridgeTool, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.client.callTool(
      { name, arguments: compactArgs(args) },
      CallToolResultSchema,
    );
    if (result.structuredContent && Object.keys(result.structuredContent).length > 0) {
      return result.structuredContent;
    }
    const content = Array.isArray(result.content)
      ? (result.content as Array<{ type: string; text?: string }>)
      : [];
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
}

function safeProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function extractEvents(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  const events = raw.events;
  if (Array.isArray(events)) return events;
  const event = raw.event;
  if (event && isRecord(event)) return [event];
  return [];
}

function normalizeEvent(raw: unknown): ChannelEvent {
  if (!isRecord(raw)) return { raw };
  return {
    id: firstString(raw, ["id", "message_id", "messageId"]),
    cursor: firstCursor(raw, ["cursor"]),
    type: firstString(raw, ["type", "event_type", "eventType"]),
    platform: firstString(raw, ["platform"]),
    target: firstString(raw, ["target"]),
    sessionKey: firstString(raw, ["session_key", "sessionKey"]),
    timestamp: firstString(raw, ["timestamp", "created_at", "createdAt"]),
    message: firstString(raw, ["message", "text", "content"]),
    raw,
  };
}

function extractChannels(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isRecord(raw)) return [];
  for (const key of ["channels", "targets", "conversations"]) {
    const value = raw[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeChannel(raw: unknown): ChannelTarget | null {
  if (!isRecord(raw)) return null;
  const target = firstString(raw, ["target", "id", "session_key", "sessionKey"]);
  if (!target) return null;
  return {
    target,
    platform: firstString(raw, ["platform"]),
    name: firstString(raw, ["name", "display_name", "displayName", "chat_name", "chatName"]),
    raw,
  };
}

function firstString(value: unknown, keys: string[]): string | undefined {
  const found = firstProperty(value, keys);
  return typeof found === "string" ? found : undefined;
}

function firstBoolean(value: unknown, keys: string[], fallback: boolean): boolean {
  const found = firstProperty(value, keys);
  return typeof found === "boolean" ? found : fallback;
}

function firstCursor(value: unknown, keys: string[]): number | string | undefined {
  const found = firstProperty(value, keys);
  return typeof found === "string" || typeof found === "number" ? found : undefined;
}

function firstProperty(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const found = value[key];
    if (found != null) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
