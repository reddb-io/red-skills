import type { CastleWorkerLaneBridge } from "../../core/castle-worker-lane-bridge.js";
import type { SpawnInvocation } from "../../core/runner-spawn.js";
import type { Runner } from "../../types/runner.js";
import { execTool, type ExecFn, type ExecOutput } from "../../runtime/exec.js";

type LinkedSignal =
  | { signal: "tool"; tool: string }
  | { signal: "usage"; input_tokens: number; output_tokens: number };

function codexSignal(line: string): LinkedSignal | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      item?: { type?: string; command?: string };
      payload?: {
        type?: string;
        info?: {
          last_token_usage?: {
            input_tokens?: number;
            output_tokens?: number;
          };
        };
      };
    };
    if (
      event.type === "item.started" &&
      event.item?.type === "command_execution" &&
      typeof event.item.command === "string"
    ) {
      return { signal: "tool", tool: event.item.command };
    }
    const usage = event.payload?.info?.last_token_usage;
    if (
      event.type === "event_msg" &&
      event.payload?.type === "token_count" &&
      typeof usage?.input_tokens === "number" &&
      typeof usage.output_tokens === "number"
    ) {
      return {
        signal: "usage",
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      };
    }
  } catch {
    // A child runner may mix non-JSON diagnostics into stdout.
  }
  return null;
}

function claudeSignal(line: string): LinkedSignal | null {
  if (!line.startsWith("{")) return null;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      message?: {
        content?: Array<{
          type?: string;
          input?: { command?: string; path?: string };
        }>;
      };
    };
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) return null;
    const tool = event.message.content.find((block) => block.type === "tool_use");
    const detail = tool?.input?.command ?? tool?.input?.path;
    return typeof detail === "string" ? { signal: "tool", tool: detail } : null;
  } catch {
    return null;
  }
}

export interface RunLinkedSubagentInput {
  runner: Runner;
  phase: "merge-resolver" | "rebase-resolver";
  invocation: SpawnInvocation;
  cwd: string;
  bridge: CastleWorkerLaneBridge;
  exec?: ExecFn;
  heartbeatMs?: number;
}

/**
 * Run a landing/rebase helper while folding its native stream and a bounded
 * periodic pulse into the owning Worker's Castle/liveness lanes.
 */
export async function runLinkedSubagent(input: RunLinkedSubagentInput): Promise<ExecOutput> {
  const run = input.exec ?? execTool;
  const identity = { runner: input.runner, phase: input.phase };
  await input.bridge.record("worker.subagent_started", identity).catch(() => {});

  let laneTail = Promise.resolve();
  const enqueue = (payload: Record<string, unknown>): void => {
    laneTail = laneTail
      .then(() => input.bridge.record("worker.subagent_heartbeat", { ...identity, ...payload }))
      .catch(() => {});
  };
  const timer = setInterval(
    () => enqueue({ signal: "timer" }),
    input.heartbeatMs ?? 15_000,
  );
  timer.unref();

  let result: ExecOutput;
  try {
    result = await run(input.invocation.command, input.invocation.args, {
      cwd: input.cwd,
      onStdoutLine: (line) => {
        const signal = input.runner === "codex" ? codexSignal(line) : claudeSignal(line);
        if (signal) enqueue(signal);
      },
    });
  } finally {
    clearInterval(timer);
  }

  await laneTail;
  await input.bridge.record("worker.subagent_finished", {
    ...identity,
    code: result.code,
  }).catch(() => {});
  return result;
}
