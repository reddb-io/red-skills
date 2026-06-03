// backpressure — the AFK operator-declared pre-merge gate (PRD #429, issue #430).
//
// A sibling of feedback.ts. Where feedback derives test/typecheck/lint/build from
// the touched package scopes, backpressure runs an EXPLICIT, operator-declared,
// ordered list of shell commands from `.red/config.yaml` (`afk.backpressure`)
// against the worker-branch worktree. It SUPPLEMENTS the feedback gate — it never
// replaces it — and runs AFTER feedback passes on the DONE path: any command that
// exits non-zero blocks the merge and parks the issue to ready-for-human exactly
// like a feedback failure.
//
// Like feedback, IO is fully injected: `exec` runs the real shell command in the
// worker-branch checkout, and `now` supplies the millisecond clock, so the
// decision logic and the `red.afk.validation.v1` sidecar record shape are
// unit-testable against fixed inputs with no real process ever spawned. The
// record shaping (`buildValidationRecord` / `outputSummary` / `formatValidationLine`)
// and the `red.afk.validation.v1` schema are reused verbatim from feedback.ts so
// the two gates emit byte-identical sidecar records.

import {
  buildValidationRecord,
  formatValidationLine,
  outputSummary,
  type ExecResult,
  type ValidationRecord,
  type ValidationStatus,
} from "./feedback.js";

/**
 * Injected shell executor for a single backpressure command. Receives the raw
 * command string (e.g. `npm run test`) and the working directory it runs in
 * (the worker-branch checkout root); resolves with the captured exit code +
 * streams. Mirrors the hook executor's `sh -c <command>` contract.
 */
export type BackpressureExec = (input: { command: string; cwd: string }) => Promise<ExecResult>;

/** One completed backpressure command, surfaced alongside its sidecar record. */
export interface BackpressureCheck {
  /** `backpressure:<cmd>`, e.g. `backpressure:npm run test`. */
  name: string;
  /** The exact command string that ran. */
  command: string;
  status: ValidationStatus;
  record: ValidationRecord;
}

export interface RunBackpressureInput {
  /** Worker-branch checkout token, passed through as each command's `cwd`. */
  worktree: string;
  /** Operator-declared commands (from `afk.backpressure`), run in order. */
  commands: readonly string[];
  /** Injected millisecond clock — no `Date.now()` at module scope. */
  now: () => number;
}

export interface RunBackpressureResult {
  /** False when any command exited non-zero — the merge gate (PRD #429). */
  ok: boolean;
  /** Every command that ran, in declaration order. */
  checks: BackpressureCheck[];
  /** The sidecar lines, one JSONL record per command, in the same order. */
  sidecar: string[];
}

/**
 * Run the operator-declared backpressure commands in order against the
 * worker-branch worktree. For each command: time it with the injected clock,
 * run it via the injected exec in the worktree dir, and emit a `passed`/`failed`
 * `red.afk.validation.v1` record named `backpressure:<cmd>`. Blank/whitespace
 * entries are skipped (not recorded). Every command runs so the operator sees
 * the full picture; `ok` is false if ANY command failed, blocking the merge. An
 * empty command list is a no-op (`ok:true`, no checks, no sidecar) — today's
 * behaviour. Nothing here touches the filesystem or a real clock.
 */
export async function runBackpressure(
  exec: BackpressureExec,
  input: RunBackpressureInput,
): Promise<RunBackpressureResult> {
  const { worktree, commands, now } = input;
  const checks: BackpressureCheck[] = [];
  const sidecar: string[] = [];
  let failed = false;

  for (const raw of commands) {
    const command = raw.trim();
    if (command === "") continue;

    const name = `backpressure:${command}`;
    const start = now();
    const result = await exec({ command, cwd: worktree });
    const durationMs = now() - start;
    const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
    if (status === "failed") failed = true;
    const summary = outputSummary(status, `${result.stdout}${result.stderr}`);
    const record = buildValidationRecord({ name, status, command, durationMs, summary });
    checks.push({ name, command, status, record });
    sidecar.push(formatValidationLine(record));
  }

  return { ok: !failed, checks, sidecar };
}
