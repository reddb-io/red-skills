/**
 * The gate the Worker runs LOCALLY, in its own Worktree (issue #4020, ADR 0135).
 *
 * The declared stages used to run in the dev bundle, one process away from the
 * body that produced the diff; ADR 0148 put the body here, so the gate came with
 * it. Running it locally is what makes the Validation moment a moment rather
 * than a hand-off: the Worker knows within its own turn whether what it just
 * committed passes, which is the only way a re-seed can carry the branch
 * forward instead of rebuilding it (ADR 0129).
 *
 * **The stage order is not restated here.** `runCastleGate` executes the
 * checks; `GATE_STAGE_ORDER` decides which blocker gets named, and this module
 * only translates one into the other. A second spelling of "feedback before
 * backpressure" is a second thing to keep true.
 *
 * **A workspace this cannot read is a SKIPPED stage, never a failed one.** A
 * Worktree with no package manifest has nothing to validate, and refusing it
 * would block work the operator declared no commands for (ADR 0135: an
 * undeclared moment is skipped, loudly).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  runCastleGate,
  type ExecResult,
  type ScriptLayout,
  type ValidationCheck,
} from "../engine/gate-executor.js";
import { KILLED_EXIT_CODE } from "../engine/gate-constants.js";
import type { GateStageOutcome } from "../engine/gate-stage-order.js";
import type { WorkspaceGraph, WorkspacePackage } from "../engine/validation-cone.js";
import type { TicketGateRun } from "./ticket-loop.js";

/** How long one backpressure command may run before the gate gives up on it. */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

export interface WorkerLocalGateOptions {
  /** The Worktree the inner agent committed in. */
  readonly worktree: string;
  /** The trunk the diff is measured against. */
  readonly base: string;
  /** The operator's extra commands, run after feedback and only if it passed. */
  readonly backpressureCommands?: readonly string[];
  /** Test seam over the package suite. Production runs real `pnpm`. */
  readonly feedbackExec?: (args: string[]) => Promise<ExecResult>;
  /** Test seam over the operator's commands. Production runs a real shell. */
  readonly backpressureExec?: (input: { command: string; cwd: string; timeoutMs: number }) => Promise<ExecResult>;
  /** Test seam over the diff. Production reads real git. */
  readonly changedFiles?: (worktree: string, base: string) => Promise<readonly string[]>;
  readonly now?: () => number;
}

export interface WorkerLocalGateResult extends TicketGateRun {
  /** Every check the gate ran, for the Worker's validation sidecar. */
  readonly checks: readonly ValidationCheck[];
  /** One TOONL-adjacent JSON line per check, as the gate artifact wants them. */
  readonly sidecar: readonly string[];
}

/**
 * Run the declared stages over what this Worktree has committed.
 *
 * Returns the stage outcomes rather than a verdict: folding them is
 * `gateVerdict`'s job, and a caller that received a boolean could not tell a
 * skipped review from a passing one.
 */
export async function runWorkerLocalGate(
  options: WorkerLocalGateOptions,
): Promise<WorkerLocalGateResult> {
  const readChanged = options.changedFiles ?? changedFilesSince;
  const changed = await readChanged(options.worktree, options.base);
  const { layout, graph } = readWorkspace(options.worktree);
  const backpressureCommands = options.backpressureCommands ?? [];

  const result = await runCastleGate({
    worktree: options.worktree,
    changedFiles: changed,
    layout,
    graph,
    backpressureCommands,
    // The Worker passes no findings, so the sink is never consulted; `parked`
    // is the honest answer for the day one arrives before a reviewer does.
    sink: { intentFinding: async () => "parked" },
    feedbackExec: options.feedbackExec ?? ((args) => runProgram(args[0]!, args.slice(1), options.worktree)),
    backpressureExec: options.backpressureExec
      ?? (({ command, cwd, timeoutMs }) => runShell(command, cwd, timeoutMs)),
    applyMechanical: async () => undefined,
    now: options.now ?? Date.now,
    backpressureTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
  });

  const feedback = result.checks.filter((check) => !check.name.startsWith("backpressure:"));
  const backpressure = result.checks.filter((check) => check.name.startsWith("backpressure:"));
  const stages: GateStageOutcome[] = [
    stageOutcome("feedback", feedback),
    stageOutcome("backpressure", backpressure),
    // The Worker body wires no reviewer yet: the diff review is the daemon's to
    // arrange, and a stage nothing runs is skipped rather than green.
    { stage: "review", ok: true, skipped: true },
  ];
  const detail = failureDetail(result.checks);
  return {
    stages,
    ...(detail == null ? {} : { detail }),
    checks: result.checks,
    sidecar: result.sidecar,
  };
}

function stageOutcome(
  stage: GateStageOutcome["stage"],
  checks: readonly ValidationCheck[],
): GateStageOutcome {
  const ran = checks.filter((check) => check.status !== "skipped");
  if (ran.length === 0) return { stage, ok: true, skipped: true };
  return { stage, ok: ran.every((check) => check.status === "passed") };
}

/** What the blocking checks said, for the re-seeded handoff. */
function failureDetail(checks: readonly ValidationCheck[]): string | undefined {
  const failed = checks.filter((check) => check.status === "failed");
  if (failed.length === 0) return undefined;
  return failed
    .map((check) => `${check.record.command ?? check.name}: ${check.record.summary ?? "exited non-zero"}`)
    .join("\n");
}

/**
 * The files this branch changed against `base`.
 *
 * A three-dot diff on purpose: the Worker's branch is measured against where it
 * FORKED, so trunk moving underneath it does not widen the validation cone into
 * packages nobody here touched.
 */
export async function changedFilesSince(
  worktree: string,
  base: string,
): Promise<readonly string[]> {
  const diff = await runProgram("git", ["diff", "--name-only", `${base}...HEAD`], worktree);
  if (diff.code !== 0) {
    // No merge base — a fixture repository, a shallow clone, a first commit.
    // Everything tracked is the honest answer, and a wider cone never lies
    // about a package it validated.
    const tracked = await runProgram("git", ["ls-files"], worktree);
    return lines(tracked.stdout);
  }
  return lines(diff.stdout);
}

function lines(output: string): string[] {
  return output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

/**
 * The Worktree's package topology, read from disk.
 *
 * `pnpm-workspace.yaml` is consulted when it exists and the root manifest alone
 * is the answer when it does not, so a single-package repository gates without
 * a workspace file and a monorepo gates by cone.
 */
export function readWorkspace(worktree: string): { layout: ScriptLayout; graph: WorkspaceGraph } {
  const dirs = workspaceDirs(worktree);
  const manifests = new Map<string, { name?: string; scripts?: Record<string, unknown>; deps: string[] }>();
  for (const dir of dirs) {
    const manifest = readManifest(worktree, dir);
    if (manifest != null) manifests.set(dir, manifest);
  }
  const dirByName = new Map<string, string>();
  for (const [dir, manifest] of manifests) {
    if (manifest.name != null) dirByName.set(manifest.name, dir);
  }
  const packages: WorkspacePackage[] = [...manifests].map(([dir, manifest]) => ({
    dir,
    dependsOn: manifest.deps
      .map((name) => dirByName.get(name))
      .filter((dependency): dependency is string => dependency != null && dependency !== dir),
  }));
  return {
    layout: {
      hasPackage: (scope) => manifests.has(scope),
      hasScript: (scope, script) => {
        const scripts = manifests.get(scope)?.scripts;
        return scripts != null && script in scripts;
      },
    },
    graph: { packages },
  };
}

/** Every directory that may hold a workspace manifest, root always included. */
function workspaceDirs(worktree: string): string[] {
  const dirs = new Set<string>(["."]);
  const workspaceFile = join(worktree, "pnpm-workspace.yaml");
  if (!existsSync(workspaceFile)) return [...dirs];
  for (const pattern of workspaceGlobs(readFileSync(workspaceFile, "utf8"))) {
    for (const dir of expandGlob(worktree, pattern)) dirs.add(dir);
  }
  return [...dirs];
}

/**
 * The `packages:` entries of a pnpm workspace file.
 *
 * Hand-parsed rather than YAML-decoded because the shape needed is one flat
 * list of strings, and a Worker that could not gate without a YAML dependency
 * would be a Worker that could not gate.
 */
export function workspaceGlobs(source: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of source.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^\s+-\s+(.+)$/.exec(line);
    if (entry == null) {
      if (line.trim() !== "") inPackages = false;
      continue;
    }
    globs.push(entry[1]!.trim().replace(/^['"]|['"]$/g, ""));
  }
  return globs;
}

/** Expand `a/b`, `a/*` and `a/**` against the Worktree. Nothing exotic. */
function expandGlob(worktree: string, pattern: string): string[] {
  if (pattern.startsWith("!")) return [];
  const star = pattern.indexOf("*");
  if (star < 0) return existsSync(join(worktree, pattern, "package.json")) ? [pattern] : [];
  const prefix = pattern.slice(0, star).replace(/\/$/, "");
  const root = prefix === "" ? worktree : join(worktree, prefix);
  const deep = pattern.slice(star).startsWith("**");
  return childDirectories(root, deep).flatMap((child) => {
    const dir = relative(worktree, child).split("\\").join("/");
    return existsSync(join(child, "package.json")) ? [dir] : [];
  });
}

function childDirectories(root: string, deep: boolean): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = join(root, entry.name);
    found.push(child);
    if (deep) found.push(...childDirectories(child, true));
  }
  return found;
}

function readManifest(
  worktree: string,
  dir: string,
): { name?: string; scripts?: Record<string, unknown>; deps: string[] } | undefined {
  const path = dir === "." ? join(worktree, "package.json") : join(worktree, dir, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = [
      ...Object.entries(parsed.dependencies ?? {}),
      ...Object.entries(parsed.devDependencies ?? {}),
    ]
      .filter(([, range]) => typeof range === "string" && range.startsWith("workspace:"))
      .map(([name]) => name);
    return {
      ...(parsed.name == null ? {} : { name: parsed.name }),
      ...(parsed.scripts == null ? {} : { scripts: parsed.scripts }),
      deps,
    };
  } catch {
    return undefined;
  }
}

function runProgram(command: string, args: readonly string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: exitCode(error), stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      process.platform === "win32" ? "cmd" : "sh",
      process.platform === "win32" ? ["/c", command] : ["-c", command],
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // A command the timeout killed is not a command that failed: the gate
        // reports it as `KILLED_EXIT_CODE` so the summary says "timed out"
        // rather than inventing a verdict the command never reached.
        const killed = (error as { killed?: boolean } | null)?.killed === true;
        resolve({
          code: killed ? KILLED_EXIT_CODE : exitCode(error),
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function exitCode(error: unknown): number {
  if (error == null) return 0;
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : 1;
}
