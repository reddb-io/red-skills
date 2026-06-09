// runtime/exec.ts — the single real-process boundary.
//
// Every gh/git/pnpm closure assembled in this runtime/ tree ultimately routes
// through `execTool`, a thin promisified wrapper over node:child_process
// execFile. It NEVER throws on a non-zero exit (the orchestrators decide what a
// non-zero code means); it resolves with {code,stdout,stderr} so callers can
// branch on the code. The thin `git` / `gh` / `pnpm` helpers fix the command
// head so call sites read as argv arrays.

import { execFile } from "node:child_process";

export interface ExecOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Process-kill timeout in milliseconds (0 / undefined = no timeout). */
  timeoutMs?: number;
  /** Max captured bytes per stream (default 16 MiB). */
  maxBuffer?: number;
  /** Optional stdin payload written to the child. */
  input?: string;
}

/**
 * The injectable exec boundary. `execTool` is the production implementation; the
 * gh/git Contexts carry an OPTIONAL field of this shape so tests can drive the
 * REAL gh/git closure assembly over a recording fake instead of the OS. When
 * unset (production), the gh/git helpers fall through to the real `execTool`, so
 * behaviour is identical to a static import.
 */
export type ExecFn = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecOutput>;

const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Exit code reported for a command killed by the exec timeout or an external
 * signal. Node's execFile leaves `error.code` null in that case (the numeric
 * exit slot is empty when the child died from a signal), so without this the
 * old `typeof code === "number" ? code : 0` fallthrough read a killed/timed-out
 * command as success — a slow model classification, or a future timed-out land,
 * silently passing (PRD #567). 124 mirrors GNU `timeout(1)`'s killed-process
 * code so any caller branching on `code !== 0` reads the kill as a failure.
 */
export const KILLED_EXIT_CODE = 124;

/**
 * Run `cmd args…` and resolve with the captured exit code + streams. A spawn
 * error (ENOENT for a missing binary, etc.) resolves with code 127 and the
 * error message on stderr rather than rejecting, so a missing `gh` reads as a
 * clean precondition signal upstream instead of an unhandled rejection. A
 * command killed by the `timeoutMs` deadline or an external signal resolves with
 * {@link KILLED_EXIT_CODE} — never code 0 — so callers branching on a non-zero
 * code read the kill as a failure.
 */
export function execTool(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        timeout: opts.timeoutMs ?? 0,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // Spawn failure (ENOENT etc.) — surface as 127 like a shell would.
          resolve({ code: 127, stdout: String(stdout ?? ""), stderr: String((error as Error).message) });
          return;
        }
        if (error && (error.killed || error.signal != null)) {
          // Timed out (timeoutMs deadline) or killed by an external signal. The
          // numeric exit code is null here, so report a non-zero failure instead
          // of letting the kill read as success.
          resolve({
            code: KILLED_EXIT_CODE,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? "") || String((error as Error).message),
          });
          return;
        }
        const code = error && typeof error.code === "number" ? error.code : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** Thin `git args…` helper (optionally pinned to a working dir via opts.cwd). */
export function git(args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return execTool("git", args, opts);
}

/** Thin `gh args…` helper. */
export function gh(args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return execTool("gh", args, opts);
}

/** Thin `pnpm args…` helper. */
export function pnpm(args: readonly string[], opts: ExecOptions = {}): Promise<ExecOutput> {
  return execTool("pnpm", args, opts);
}
