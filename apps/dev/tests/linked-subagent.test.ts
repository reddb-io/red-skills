import { describe, expect, it } from "vitest";
import { runLinkedSubagent } from "../src/commands/run/linked-subagent.js";
import type { CastleWorkerLaneBridge } from "../src/core/castle-worker-lane-bridge.js";
import type { ExecFn } from "../src/runtime/exec.js";

describe("runLinkedSubagent", () => {
  it("folds native Codex tool and usage events into the parent Worker lane (#2480)", async () => {
    const records: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
    const bridge: CastleWorkerLaneBridge = {
      record: async (kind, payload) => {
        records.push({ kind, payload });
      },
      log: async () => {},
      snapshot: async () => {},
    };
    const exec: ExecFn = async (_command, _args, options) => {
      options?.onStdoutLine?.(JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "git rebase --continue" },
      }));
      options?.onStdoutLine?.(JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 209_000,
              cached_input_tokens: 0,
              output_tokens: 37_000,
            },
          },
        },
      }));
      return { code: 0, stdout: "", stderr: "" };
    };

    await runLinkedSubagent({
      runner: "codex",
      phase: "rebase-resolver",
      invocation: { command: "codex", args: ["exec", "--json"] },
      cwd: "/repo",
      bridge,
      exec,
      heartbeatMs: 60_000,
    });

    expect(records).toEqual([
      {
        kind: "worker.subagent_started",
        payload: { runner: "codex", phase: "rebase-resolver" },
      },
      {
        kind: "worker.subagent_heartbeat",
        payload: {
          runner: "codex",
          phase: "rebase-resolver",
          signal: "tool",
          tool: "git rebase --continue",
        },
      },
      {
        kind: "worker.subagent_heartbeat",
        payload: {
          runner: "codex",
          phase: "rebase-resolver",
          signal: "usage",
          input_tokens: 209_000,
          output_tokens: 37_000,
        },
      },
      {
        kind: "worker.subagent_finished",
        payload: { runner: "codex", phase: "rebase-resolver", code: 0 },
      },
    ]);
  });

  it("folds native Claude tool events into the parent Worker lane (#2480)", async () => {
    const records: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
    const bridge: CastleWorkerLaneBridge = {
      record: async (kind, payload) => {
        records.push({ kind, payload });
      },
      log: async () => {},
      snapshot: async () => {},
    };
    const exec: ExecFn = async (_command, _args, options) => {
      options?.onStdoutLine?.(JSON.stringify({
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            name: "Bash",
            input: { command: "git rebase --continue" },
          }],
        },
      }));
      return { code: 0, stdout: "", stderr: "" };
    };

    await runLinkedSubagent({
      runner: "claude",
      phase: "merge-resolver",
      invocation: { command: "claude", args: ["--output-format", "stream-json"] },
      cwd: "/repo",
      bridge,
      exec,
      heartbeatMs: 60_000,
    });

    expect(records).toContainEqual({
      kind: "worker.subagent_heartbeat",
      payload: {
        runner: "claude",
        phase: "merge-resolver",
        signal: "tool",
        tool: "git rebase --continue",
      },
    });
  });
});
