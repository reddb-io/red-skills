import {
  McpStdioChannelBridge,
  type ChannelBridge,
  type ChannelBridgeProcess,
  type ChannelBridgeSendResult,
} from "./channel-bridge.js";

export interface BrainActInput {
  target: string;
  message: string;
}

export interface BrainActResult {
  ok: true;
  target: string;
  messageId?: string;
  raw: unknown;
}

/** Connects a {@link ChannelBridge}, given optional process parameters. Injectable for tests. */
export type ChannelBridgeConnector = (processParams?: ChannelBridgeProcess) => Promise<ChannelBridge>;

export interface BrainActOptions {
  /** Override the bridge connector (defaults to a real `hermes mcp serve` MCP-stdio bridge). */
  connect?: ChannelBridgeConnector;
  /** Override the bridge process parameters (defaults to the outbound-only resolution). */
  process?: ChannelBridgeProcess;
  /** Environment used to resolve the bridge process (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

/** A brain-scoped failure when acting on a channel. Keeps Hermes/bridge specifics out of the message. */
export class BrainActError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BrainActError";
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * Sends a message to a channel target through the ChannelBridge `send()` path, outbound-only:
 * the bridge runs standalone (`hermes mcp serve`) using configured channel tokens, no gateway
 * daemon required. Failure modes (missing token, bad target, unreachable bridge) surface as a
 * {@link BrainActError} with a clear, brain-scoped message.
 */
export async function brainAct(input: BrainActInput, options: BrainActOptions = {}): Promise<BrainActResult> {
  const target = input.target?.trim();
  const message = input.message;
  if (!target) throw new BrainActError("brain_act requires a non-empty channel target");
  if (!message || !message.trim()) throw new BrainActError("brain_act requires a non-empty message");

  const connect = options.connect ?? ((processParams) => McpStdioChannelBridge.connect(processParams));
  const processParams = options.process ?? resolveChannelBridgeProcess(options.env ?? process.env);

  let bridge: ChannelBridge;
  try {
    bridge = await connect(processParams);
  } catch (err) {
    throw new BrainActError(`brain_act could not reach the channel bridge: ${errorMessage(err)}`, { cause: err });
  }

  try {
    let result: ChannelBridgeSendResult;
    try {
      result = await bridge.send(target, message);
    } catch (err) {
      throw new BrainActError(`brain_act could not send to "${target}": ${errorMessage(err)}`, { cause: err });
    }
    if (!result.ok) {
      throw new BrainActError(`brain_act could not send to "${target}": ${sendFailureReason(result)}`);
    }
    return { ok: true, target: result.target, messageId: result.messageId, raw: result.raw };
  } finally {
    await bridge.close().catch(() => {});
  }
}

/**
 * Resolves the outbound-only bridge process. Defaults (`hermes mcp serve` with the inherited
 * environment carrying channel tokens) are applied by {@link McpStdioChannelBridge.connect}; this
 * only layers optional env overrides so a non-default bridge command can be configured.
 */
export function resolveChannelBridgeProcess(
  env: Record<string, string | undefined> = process.env,
): ChannelBridgeProcess {
  const command = env.RED_BRAIN_HERMES_COMMAND?.trim() || undefined;
  const rawArgs = env.RED_BRAIN_HERMES_ARGS?.trim();
  const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : undefined;
  return { command, args };
}

function sendFailureReason(result: ChannelBridgeSendResult): string {
  const reason = firstString(result.raw, ["error", "message", "reason", "detail"]);
  return reason ?? "the channel bridge reported a failed send";
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.trim()) return found;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
