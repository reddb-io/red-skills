/**
 * The Worker's answer to the child Agent's `terminal/*` methods.
 *
 * The inner coding Agent mounts no MCP and holds no credential; every command
 * it wants to run comes back up the ACP wire as a request, and THIS is what
 * decides and then executes it (ADR 0148). Two things happen here and nowhere
 * else: `terminal-policy.ts` judges the command, and an allowed one runs as a
 * child of the Worker, in the Worker's Worktree, with the Worker's already
 * credential-free environment.
 *
 * Execution stays in the Worker rather than being forwarded to the ACP parent
 * because the parent is control: it decides whether a Worker exists, not what
 * runs inside one.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  RequestError,
  type CreateTerminalRequest,
  type CreateTerminalResponse,
  type KillTerminalRequest,
  type KillTerminalResponse,
  type ReleaseTerminalRequest,
  type ReleaseTerminalResponse,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { isCredentialEnvironmentName } from "@reddb-io/shared/credential-free-env.js";
import {
  evaluateWorkerTerminalRequest,
  workerTerminalDenialMessage,
  workerTerminalDenialMeta,
  type WorkerTerminalDenial,
} from "./terminal-policy.js";

/** Retained output per terminal when the caller states no limit of its own. */
export const DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT = 1_048_576;

export interface WorkerTerminalHostOptions {
  /** The Worktree. A request naming no `cwd` runs here, never in the Worker's own. */
  readonly cwd: string;
  /** The environment allowed children inherit. Already stripped of credentials. */
  readonly env: NodeJS.ProcessEnv;
  /** Test seam. Production passes nothing and gets `node:child_process`. */
  readonly spawn?: typeof nodeSpawn;
  /** Called with every refusal, so the Worker's log records what it taught. */
  readonly onDenial?: (denial: WorkerTerminalDenial) => void;
}

export interface WorkerTerminalHost {
  create(params: CreateTerminalRequest): CreateTerminalResponse;
  output(params: TerminalOutputRequest): TerminalOutputResponse;
  waitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse>;
  kill(params: KillTerminalRequest): KillTerminalResponse;
  release(params: ReleaseTerminalRequest): ReleaseTerminalResponse;
  /** Kill and forget every terminal this host still holds. */
  closeAll(): void;
}

interface HeldTerminal {
  readonly child: ChildProcess;
  readonly limit: number;
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
  exit: { readonly exitCode: number | null; readonly signal: string | null } | undefined;
  readonly exited: Promise<void>;
}

export function createWorkerTerminalHost(options: WorkerTerminalHostOptions): WorkerTerminalHost {
  const spawn = options.spawn ?? nodeSpawn;
  const terminals = new Map<string, HeldTerminal>();
  let minted = 0;

  const held = (terminalId: string): HeldTerminal => {
    const terminal = terminals.get(terminalId);
    if (terminal == null) throw RequestError.resourceNotFound(terminalId);
    return terminal;
  };

  return {
    create(params) {
      const decision = evaluateWorkerTerminalRequest(params);
      if (decision.decision === "deny") {
        options.onDenial?.(decision);
        throw RequestError.authRequired(
          workerTerminalDenialMeta(decision),
          workerTerminalDenialMessage(decision),
        );
      }
      minted += 1;
      const terminalId = `worker-terminal-${minted}`;
      const child = spawn(params.command, [...(params.args ?? [])], {
        cwd: params.cwd ?? options.cwd,
        env: { ...options.env, ...declaredEnv(params) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const terminal: HeldTerminal = {
        child,
        limit: params.outputByteLimit ?? DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT,
        chunks: [],
        bytes: 0,
        truncated: false,
        exit: undefined,
        exited: new Promise<void>((resolve) => {
          child.once("error", () => {
            terminal.exit = { exitCode: null, signal: null };
            resolve();
          });
          child.once("close", (code, signal) => {
            terminal.exit = { exitCode: code, signal: signal ?? null };
            resolve();
          });
        }),
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("data", (chunk: Buffer) => retain(terminal, chunk));
      }
      terminals.set(terminalId, terminal);
      return { terminalId };
    },

    output(params) {
      const terminal = held(params.terminalId);
      return {
        output: Buffer.concat(terminal.chunks).toString("utf8"),
        truncated: terminal.truncated,
        ...(terminal.exit == null ? {} : { exitStatus: terminal.exit }),
      };
    },

    async waitForExit(params) {
      const terminal = held(params.terminalId);
      await terminal.exited;
      return terminal.exit ?? { exitCode: null, signal: null };
    },

    kill(params) {
      held(params.terminalId).child.kill();
      return {};
    },

    release(params) {
      const terminal = held(params.terminalId);
      terminals.delete(params.terminalId);
      if (terminal.exit == null) terminal.child.kill();
      return {};
    },

    closeAll() {
      for (const terminal of terminals.values()) {
        if (terminal.exit == null) terminal.child.kill();
      }
      terminals.clear();
    },
  };
}

/**
 * Keep the tail of the output within the caller's byte limit.
 *
 * Trimming happens from the FRONT, per ACP: a command's last words are the ones
 * that say how it ended. The trim then advances to the next UTF-8 lead byte, so
 * a multi-byte character cut in half never reaches the agent as a replacement
 * character it will try to interpret.
 */
function retain(terminal: HeldTerminal, chunk: Buffer): void {
  terminal.chunks.push(chunk);
  terminal.bytes += chunk.byteLength;
  if (terminal.bytes <= terminal.limit) return;
  terminal.truncated = true;
  let joined = Buffer.concat(terminal.chunks);
  let start = joined.byteLength - terminal.limit;
  while (start < joined.byteLength && (joined[start]! & 0xc0) === 0x80) start += 1;
  joined = joined.subarray(start);
  terminal.chunks = [joined];
  terminal.bytes = joined.byteLength;
}

/**
 * The variables the request itself declares, minus every credential name.
 *
 * The inner agent has no credential to inject, so the filter buys nothing
 * today; it exists so that the ONE place a child-named environment enters a
 * Worker-spawned process is the same place that already refuses those names.
 */
function declaredEnv(params: CreateTerminalRequest): Record<string, string> {
  const declared: Record<string, string> = {};
  for (const variable of params.env ?? []) {
    if (isCredentialEnvironmentName(variable.name)) continue;
    declared[variable.name] = variable.value;
  }
  return declared;
}
