// go — the `/go` dispatch command (ADR 0081, PRD #928 / issue #938 / S4).
//
// `/go "<demand>"` is the semi-structured front door between `/goal` and
// `/afk`. It mints a DISPOSABLE tracking issue in the isolated `lane:go` lane
// (out of `ready-for-agent`, so the running fleet can never claim it), spins a
// DEDICATED namespaced worker under `.red/tmp/go-workers/` (separate from the
// fleet's `.red/tmp/workers/`), and reuses the ENTIRE AFK engine end-to-end
// with `origin=go` and the interactive gate sink. The disposable issue
// auto-closes on merge (the engine's PR body carries `Closes #N`). Works with
// or without a fleet running — it is a self-sufficient front door.
//
// The classification + escalation logic lives in core/go.ts (pure, injected
// IO); this command supplies the real gh + engine effects and the namespaced
// worker root.

import {
  dispatchGo,
  parseGoMode,
  DEFAULT_GO_MODE,
  GO_WORKERS_SEGMENT,
  type DisposableIssueSpec,
  type GoMode,
} from "../core/go.js";
import { dispatchScout, SCOUT_WORKERS_SEGMENT, type ScoutIssueSpec } from "../core/scout.js";
import { resolveRepoContext } from "../runtime/wire.js";
import { runCommand } from "./run.js";
import * as ghx from "../runtime/gh.js";
import type { GhContext } from "../runtime/gh.js";

/** Parse `/go` args: the demand is every non-flag token joined; `--runner X`
 * (or `-r X`) optionally pins the backend; `--mode {no-mistakes|direct-PR|
 * local-only}` selects the dispatch mode (default `direct-PR`); the opt-in
 * `+yolo` token bumps autonomy; `--scout` switches to read-only investigation
 * mode. A leading `--` is tolerated so `/go -- --literal` passes a dashed
 * demand through. */
export function parseGoArgs(
  args: readonly string[],
): { demand: string; runner?: string; mode: GoMode; yolo: boolean; scout?: boolean } {
  const positional: string[] = [];
  let runner: string | undefined;
  let mode: GoMode = DEFAULT_GO_MODE;
  let yolo = false;
  let scout = false;
  let sawDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!sawDoubleDash && arg === "--") { sawDoubleDash = true; continue; }
    if (!sawDoubleDash && (arg === "--runner" || arg === "-r")) {
      runner = args[++i];
      if (runner === undefined) throw new Error(`${arg} requires a value`);
      continue;
    }
    if (!sawDoubleDash && arg.startsWith("--runner=")) {
      runner = arg.slice("--runner=".length);
      continue;
    }
    if (!sawDoubleDash && arg === "--mode") {
      const value = args[++i];
      if (value === undefined) throw new Error("--mode requires a value");
      mode = parseGoMode(value);
      continue;
    }
    if (!sawDoubleDash && arg.startsWith("--mode=")) {
      mode = parseGoMode(arg.slice("--mode=".length));
      continue;
    }
    if (!sawDoubleDash && arg === "+yolo") { yolo = true; continue; }
    if (!sawDoubleDash && arg === "--scout") { scout = true; continue; }
    positional.push(arg);
  }
  return { demand: positional.join(" ").trim(), runner, mode, yolo, scout };
}

export async function goCommand(args: string[], cwd = process.cwd()): Promise<number> {
  let parsed: { demand: string; runner?: string; mode: GoMode; yolo: boolean; scout?: boolean };
  try {
    parsed = parseGoArgs(args);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!parsed.demand) {
    console.error(
      parsed.scout
        ? '✗ /go --scout requires a question, e.g. /go --scout "what does the dispatch engine do?"'
        : '✗ /go requires a demand, e.g. /go "fix the flaky login test"',
    );
    return 1;
  }

  const ctx = await resolveRepoContext(cwd);
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  if (parsed.scout) {
    // Scout mode: read-only investigation, no commits / branch / PR / merge.
    // Namespace under scout-workers/ so it never collides with go-workers/ or
    // the fleet's workers/.
    process.env.RED_AFK_WORKERS_NAMESPACE = SCOUT_WORKERS_SEGMENT;
    try {
      const result = await dispatchScout(
        {
          ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
          createIssue: (spec: ScoutIssueSpec) => ghx.createIssue(ghCtx, spec),
          runEngine: (engineArgs) => runCommand({ args: engineArgs, cwd }),
        },
        parsed.demand,
        { runner: parsed.runner },
      );
      process.stdout.write(
        `🔍 /go --scout dispatched disposable issue #${result.issue} (origin=scout, lane:scout, scout-workers/). ` +
          `engine exit ${result.engineExit}.\n`,
      );
      return result.engineExit;
    } catch (error) {
      console.error(`✗ /go --scout dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  // Standard /go: namespace under go-workers/ so the single-shot worker never
  // collides with the fleet's workers/. Read per-call by
  // worker-paths.workersSegment(); scoped to this process.
  process.env.RED_AFK_WORKERS_NAMESPACE = GO_WORKERS_SEGMENT;

  try {
    const result = await dispatchGo(
      {
        ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
        createIssue: (spec: DisposableIssueSpec) => ghx.createIssue(ghCtx, spec),
        // Reuse the full AFK engine in-process for exactly the minted issue.
        runEngine: (engineArgs) => runCommand({ args: engineArgs, cwd }),
      },
      parsed.demand,
      { runner: parsed.runner, mode: parsed.mode, yolo: parsed.yolo },
    );
    process.stdout.write(
      `🚀 /go dispatched disposable issue #${result.issue} ` +
        `(origin=go, lane:go, go-workers/, mode=${parsed.mode}${parsed.yolo ? ", +yolo" : ""}). ` +
        `engine exit ${result.engineExit}.\n`,
    );
    return result.engineExit;
  } catch (error) {
    console.error(`✗ /go dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
