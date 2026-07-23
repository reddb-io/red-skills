/**
 * No-sandbox provider — runs the agent directly on the host with no container isolation.
 *
 * Usage:
 *   import { noSandbox } from "sandcastle/sandboxes/no-sandbox";
 *   await interactive({ agent: claudeCode("claude-opus-4-8"), sandbox: noSandbox() });
 *
 * Accepted by `run()`, `interactive()`, and `createSandbox()`. Skips
 * container isolation entirely — the agent executes on the host. Does not
 * pass `--dangerously-skip-permissions` to the agent — the user manages
 * permissions themselves.
 */

import { spawn, type StdioOptions } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  NoSandboxProvider,
  NoSandboxHandle,
  ExecResult,
  InteractiveExecOptions,
} from "../SandboxProvider.js";
import { BoundedTail, MAX_TAIL_CHARS } from "../boundedTail.js";

const PROCESS_GROUP_POLL_MS = 50;
const PROCESS_GROUP_GRACE_TRIES = 10;
const PROCESS_GROUP_KILL_TRIES = 20;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function terminateProcessGroup(pgid: number): Promise<boolean> {
  const signal = (value: NodeJS.Signals): void => {
    try {
      process.kill(-pgid, value);
    } catch {
      // The group already exited.
    }
  };
  signal("SIGTERM");
  for (let i = 0; i < PROCESS_GROUP_GRACE_TRIES; i += 1) {
    if (!processGroupAlive(pgid)) return true;
    await sleep(PROCESS_GROUP_POLL_MS);
  }
  signal("SIGKILL");
  for (let i = 0; i < PROCESS_GROUP_KILL_TRIES; i += 1) {
    if (!processGroupAlive(pgid)) return true;
    await sleep(PROCESS_GROUP_POLL_MS);
  }
  return !processGroupAlive(pgid);
}

export interface NoSandboxOptions {
  /** Environment variables injected by this provider. Merged at launch time. */
  readonly env?: Record<string, string>;
  /**
   * Maximum number of characters of streamed `exec` output retained per stream
   * (stdout and stderr) when an `onLine` callback is supplied (default: 64KiB).
   *
   * Output is delivered live to `onLine` regardless; this only bounds the tail
   * returned in `ExecResult`, preventing a long-running agent's output from
   * overflowing V8's max string length and crashing the run.
   */
  readonly maxOutputTailChars?: number;
  /**
   * Opt-in host-environment minimization. When set, the spawned agent and
   * every `exec` inherit ONLY the `process.env` keys matching one of these
   * entries — an exact name (`"HOME"`) or a `*`-suffixed prefix glob
   * (`"CLAUDE*"`, `"LC_*"`) — plus whatever `env`/`createOptions.env` inject
   * explicitly. Absent → the full host `process.env` is inherited (the
   * historical behavior). Use this to keep unrelated host secrets (cloud
   * keys, shell exports) out of the agent process.
   */
  readonly hostEnvAllowlist?: readonly string[];
}

/**
 * Filter `env` down to the keys admitted by `allowlist` (exact names or
 * `*`-suffixed prefix globs). Exported for tests.
 *
 * @internal
 */
export const pickAllowedEnv = (
  env: NodeJS.ProcessEnv,
  allowlist: readonly string[],
): Record<string, string> => {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const entry of allowlist) {
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else exact.add(entry);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (exact.has(key) || prefixes.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
};

/**
 * Create a no-sandbox provider.
 *
 * The returned provider runs the agent directly on the host. All three
 * branch strategies are supported (head, merge-to-head, branch),
 * defaulting to head.
 */
export const noSandbox = (options?: NoSandboxOptions): NoSandboxProvider => ({
  tag: "none",
  name: "no-sandbox",
  env: options?.env ?? {},
  create: async (createOptions): Promise<NoSandboxHandle> => {
    const worktreePath = createOptions.worktreePath;
    const baseEnv = options?.hostEnvAllowlist
      ? pickAllowedEnv(process.env, options.hostEnvAllowlist)
      : process.env;
    const processEnv = { ...baseEnv, ...createOptions.env };
    const maxOutputTailChars = options?.maxOutputTailChars ?? MAX_TAIL_CHARS;

    const handle: NoSandboxHandle = {
      worktreePath,

      exec: (
        command: string,
        opts?: {
          onLine?: (line: string) => void;
          cwd?: string;
          sudo?: boolean;
          stdin?: string;
          signal?: AbortSignal;
        },
      ): Promise<ExecResult> => {
        // sudo is a no-op for no-sandbox — the user is already on the host
        const cwd = opts?.cwd ?? worktreePath;
        const isWindows = process.platform === "win32";
        // PowerShell and cmd.exe don't ship `sh`, so on Windows route the
        // command string through cmd.exe instead. `/d` skips AutoRun, `/s`
        // preserves the quoted command verbatim, `/c` runs it and exits.
        // `windowsVerbatimArguments` keeps Node from re-quoting our args.
        const shellCmd = isWindows ? "cmd.exe" : "sh";
        const shellArgs = isWindows
          ? ["/d", "/s", "/c", command]
          : ["-c", command];

        return new Promise((resolve, reject) => {
          const proc = spawn(shellCmd, shellArgs, {
            cwd,
            env: processEnv,
            stdio: [
              opts?.stdin !== undefined ? "pipe" : "ignore",
              "pipe",
              "pipe",
            ],
            windowsVerbatimArguments: isWindows,
            detached: !isWindows,
          });
          let termination: Promise<boolean> | undefined;
          const terminate = (): Promise<boolean> => {
            if (termination) return termination;
            if (proc.pid === undefined) return Promise.resolve(true);
            if (isWindows) {
              proc.kill("SIGKILL");
              return Promise.resolve(true);
            }
            termination = terminateProcessGroup(proc.pid);
            return termination;
          };
          const onAbort = (): void => {
            void terminate();
          };
          opts?.signal?.addEventListener("abort", onAbort, { once: true });
          if (opts?.signal?.aborted) onAbort();
          const settle = async (code: number | null, result: Omit<ExecResult, "exitCode">): Promise<void> => {
            opts?.signal?.removeEventListener("abort", onAbort);
            if (code === null && !termination) void terminate();
            if (termination && !(await termination)) {
              reject(new Error("exec failed: process-group cleanup could not be confirmed"));
              return;
            }
            resolve({ ...result, exitCode: code ?? (opts?.signal?.aborted ? 124 : 0) });
          };

          if (opts?.stdin !== undefined) {
            proc.stdin!.write(opts.stdin);
            proc.stdin!.end();
          }

          proc.on("error", (error) => {
            opts?.signal?.removeEventListener("abort", onAbort);
            reject(new Error(`exec failed: ${error.message}`));
          });

          if (opts?.onLine) {
            const onLine = opts.onLine;
            const stdoutTail = new BoundedTail(maxOutputTailChars, "\n");
            const stderrTail = new BoundedTail(maxOutputTailChars, "");
            const rl = createInterface({ input: proc.stdout! });
            rl.on("line", (line) => {
              stdoutTail.push(line);
              onLine(line);
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrTail.push(chunk.toString());
            });
            proc.on("close", (code) => {
              void settle(code, {
                stdout: stdoutTail.toString(),
                stderr: stderrTail.toString(),
              });
            });
          } else {
            const stdoutChunks: string[] = [];
            const stderrChunks: string[] = [];
            proc.stdout!.on("data", (chunk: Buffer) => {
              stdoutChunks.push(chunk.toString());
            });
            proc.stderr!.on("data", (chunk: Buffer) => {
              stderrChunks.push(chunk.toString());
            });
            proc.on("close", (code) => {
              void settle(code, {
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
              });
            });
          }
        });
      },

      interactiveExec: (
        args: string[],
        opts: InteractiveExecOptions,
      ): Promise<{ exitCode: number }> => {
        return new Promise((resolve, reject) => {
          const [cmd, ...rest] = args;
          // Agent CLIs on Windows are typically installed as `.cmd`/`.ps1`
          // npm wrappers; bare `spawn("claude", …)` only resolves `.exe`
          // without `shell: true`, so let cmd.exe handle PATHEXT lookup.
          const proc = spawn(cmd!, rest, {
            cwd: opts.cwd ?? worktreePath,
            env: processEnv,
            stdio: [
              opts.stdin,
              opts.stdout,
              opts.stderr,
            ] as unknown as StdioOptions,
            shell: process.platform === "win32",
          });

          proc.on("error", (error: Error) => {
            reject(new Error(`exec failed: ${error.message}`));
          });

          proc.on("close", (code: number | null) => {
            resolve({ exitCode: code ?? 0 });
          });
        });
      },

      close: async (): Promise<void> => {
        // No-op — no container to tear down
      },
    };

    return handle;
  },
});
