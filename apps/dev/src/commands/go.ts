// go — the `/go` dispatch command (ADR 0081, PRD #928 / issue #938 / S4).
//
// `/go "<demand>"` is the semi-structured front door between `/goal` and
// `/afk`. It mints a DISPOSABLE tracking issue in the isolated `lane:go` lane
// (out of `ready-for-agent`, so the running fleet can never claim it), spins a
// DEDICATED castle worker with `--kind go`, and reuses the ENTIRE AFK engine
// end-to-end with `origin=go` and the interactive gate sink. The disposable issue
// auto-closes on merge (the engine's PR body carries `Closes #N`). Works with
// or without a fleet running — it is a self-sufficient front door.
//
// **Dispatch survives the dispatcher (#3027).** The engine used to run
// IN-PROCESS, so `/go` and `/go --scout` were the work rather than the order:
// a UI stop, a session teardown or a closed terminal killed the launcher and
// took the investigation with it — observed 2026-08-01, two scout dispatches
// dead with no record anywhere. So the default asks the host daemon for the
// Worker (the same birth port the MCP dispatch uses, ADR 0130), which owns a
// process this command is not the parent of, and the answer returns
// immediately naming the worker id and the log lane to watch it in. `--attached`
// opts back into the in-process run for a foreground debug session, and states
// what it costs.
//
// The classification + escalation logic lives in core/go.ts (pure, injected
// IO); this command supplies the real gh + engine effects.

import {
  dispatchGo,
  parseGoMode,
  DEFAULT_GO_MODE,
  type GoDodSpec,
  type DisposableIssueSpec,
  type GoMode,
} from "../core/go.js";
import { loadConfig, readBackpressure } from "../core/config.js";
import { dispatchScout, SCOUT_WORKERS_SEGMENT, type ScoutIssueSpec } from "../core/scout.js";
import { afkPaths, resolveRepoContext } from "../runtime/wire.js";
import { runCommand } from "./run.js";
import * as ghx from "../runtime/gh.js";
import type { GhContext } from "../runtime/gh.js";
import { execTool } from "../runtime/exec.js";
import { createGitHubTrackerAdapter } from "@reddb-io/red-castle/engine";
import {
  requestWorkerBirth,
  type DispatchedWorkerBirth,
} from "../runtime/mcp-worker-birth.js";

interface ParsedGoArgs {
  demand: string;
  runner?: string;
  mode: GoMode;
  yolo: boolean;
  scout?: boolean;
  attached: boolean;
  dod?: string;
  verifyCommand?: string;
  request?: string;
  tags?: string[];
}

/** Every effect one `/go` dispatch performs, so the dispatch DECISIONS — detach
 * or attach, what the answer names — are testable without gh, a daemon, or a
 * Worker. A real run injects nothing. */
export interface GoRuntime {
  ensureLabel(name: string): Promise<void>;
  createGoIssue(spec: DisposableIssueSpec): Promise<number>;
  createScoutIssue(spec: ScoutIssueSpec): Promise<number>;
  /** Ask the host for a Worker it owns; the caller is not its parent, so the
   * caller's death is not the Worker's (ADR 0130, #3027). */
  birthWorker(args: readonly string[]): Promise<DispatchedWorkerBirth>;
  /** Run the engine in THIS process — reached only through `--attached`. */
  runEngineAttached(args: string[]): Promise<number>;
  /** Whether a validation harness is configured, for the minted issue's DoD. */
  hasHarness: boolean;
  write(text: string): void;
}

/** The real effects: gh for the issue, the host daemon for the Worker. */
async function createDefaultGoRuntime(cwd: string): Promise<GoRuntime> {
  const ctx = await resolveRepoContext(cwd);
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };
  const tracker = createGitHubTrackerAdapter({
    repo: ctx.repo,
    gh: async (args: readonly string[]) => {
      const result = await execTool("gh", args, { cwd: ctx.root });
      if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout || `gh exited ${result.code}`).trim());
      }
      return result.stdout;
    },
  });
  const configuredBackpressure = readBackpressure(
    loadConfig(afkPaths(ctx.root).configPath, { warn: () => undefined }),
  );
  return {
    ensureLabel: (name) => ghx.ensureLabel(ghCtx, name),
    createGoIssue: (spec) => tracker.createIssue!(spec),
    createScoutIssue: (spec) => ghx.createIssue(ghCtx, spec),
    birthWorker: (args) => requestWorkerBirth(ctx.root, args),
    runEngineAttached: (args) => runCommand({ args, cwd }),
    hasHarness: configuredBackpressure.length > 0,
    write: (text) => process.stdout.write(text),
  };
}

/** The lines a detached dispatch answers with: what was born, and where to
 * watch it WITHOUT this process. A dispatch that only said "dispatched" left an
 * operator with nothing to follow once the launcher was gone (#3027). */
export function detachedDispatchAnswer(
  headline: string,
  granted: DispatchedWorkerBirth,
): string {
  return [
    headline,
    `   worker ${granted.worker_id} (pid ${granted.pid}) — detached from this session; ` +
      `stopping the dispatcher does not stop it.`,
    `   watch: ${granted.log}`,
    ...granted.warnings.map((warning) => `   ⚠ ${warning}`),
    "",
  ].join("\n");
}

/** Parse `/go` args: the demand is every non-flag token joined; `--runner X`
 * optionally pins the backend; `--request X` forwards per-dispatch steering to
 * the inner agent prompt; `--mode {no-mistakes|direct-PR|local-only}` selects
 * the dispatch mode (default `direct-PR`); the opt-in `+yolo` token bumps
 * autonomy; `--scout` switches to read-only investigation mode; `--tags a,b`
 * stamps territory `tag:<value>` labels on the minted issue. A leading `--`
 * is tolerated so `/go -- --literal` passes a dashed demand through. */
export function parseGoArgs(
  args: readonly string[],
): ParsedGoArgs {
  const positional: string[] = [];
  let runner: string | undefined;
  let mode: GoMode = DEFAULT_GO_MODE;
  let yolo = false;
  let scout = false;
  let attached = false;
  let dod: string | undefined;
  let verifyCommand: string | undefined;
  let request: string | undefined;
  let tags: string[] | undefined;
  const parseTagList = (raw: string): string[] => {
    const values = raw.split(",").map((t) => t.trim()).filter(Boolean);
    if (values.length === 0) throw new Error("--tags requires at least one tag value");
    return values;
  };
  let sawDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!sawDoubleDash && arg === "--") { sawDoubleDash = true; continue; }
    if (!sawDoubleDash && arg === "--runner") {
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
    // The opt-out, never the default: an attached run dies with its launcher.
    if (!sawDoubleDash && arg === "--attached") { attached = true; continue; }
    if (!sawDoubleDash && arg === "--dod") {
      dod = args[++i];
      if (dod === undefined) throw new Error("--dod requires a value");
      continue;
    }
    if (!sawDoubleDash && arg.startsWith("--dod=")) {
      dod = arg.slice("--dod=".length);
      continue;
    }
    if (!sawDoubleDash && arg === "--verify") {
      verifyCommand = args[++i];
      if (verifyCommand === undefined) throw new Error("--verify requires a value");
      continue;
    }
    if (!sawDoubleDash && arg.startsWith("--verify=")) {
      verifyCommand = arg.slice("--verify=".length);
      continue;
    }
    if (!sawDoubleDash && arg === "--request") {
      request = args[++i];
      if (request === undefined) throw new Error("--request requires a value");
      continue;
    }
    if (!sawDoubleDash && arg.startsWith("--request=")) {
      request = arg.slice("--request=".length);
      continue;
    }
    if (!sawDoubleDash && arg === "--tags") {
      const value = args[++i];
      if (value === undefined) throw new Error("--tags requires a value");
      tags = parseTagList(value);
      continue;
    }
    if (!sawDoubleDash && arg.startsWith("--tags=")) {
      tags = parseTagList(arg.slice("--tags=".length));
      continue;
    }
    // Unknown flag before the `--` separator is an error, never demand text
    // (#1045): folding e.g. `--resume 1043` into the demand silently minted a
    // junk issue about a flag the user meant as a command. A literal dashed
    // demand still works via the `--` separator (`/go -- --literal`).
    if (!sawDoubleDash && arg.startsWith("-")) {
      throw new Error(
        `unknown flag ${JSON.stringify(arg)}: expected --runner, --request, --mode, --scout, --attached, or +yolo. ` +
          `Also accepted for standard /go: --dod, --verify, and --tags. ` +
          `Pass a literal dashed demand after a "--" separator.`,
      );
    }
    positional.push(arg);
  }
  return { demand: positional.join(" ").trim(), runner, mode, yolo, scout, attached, dod, verifyCommand, request, tags };
}

export async function goCommand(
  args: string[],
  cwd = process.cwd(),
  runtimeOverride?: GoRuntime,
): Promise<number> {
  let parsed: ParsedGoArgs;
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

  const runtime = runtimeOverride ?? (await createDefaultGoRuntime(cwd));

  // Detached is the default and attached is the exception, so the branch is
  // written once here: `runEngine` either hands the work to the host and
  // returns, or runs it in this process and waits for it.
  let granted: DispatchedWorkerBirth | undefined;
  const runEngine = async (engineArgs: string[]): Promise<number> => {
    if (parsed.attached) return runtime.runEngineAttached(engineArgs);
    granted = await runtime.birthWorker(engineArgs);
    return 0;
  };

  if (parsed.scout) {
    // Scout mode: read-only investigation, no commits / branch / PR / merge.
    // The current engine stamps this as kind=scout; the legacy namespace env is
    // kept only for compatibility with older readers.
    process.env.RED_AFK_WORKERS_NAMESPACE = SCOUT_WORKERS_SEGMENT;
    try {
      const result = await dispatchScout(
        {
          ensureLabel: (name) => runtime.ensureLabel(name),
          createIssue: (spec: ScoutIssueSpec) => runtime.createScoutIssue(spec),
          runEngine,
        },
        parsed.demand,
        { runner: parsed.runner },
      );
      const headline =
        `🔍 /go --scout dispatched disposable issue #${result.issue} ` +
        `(origin=scout, kind=scout, lane:scout).`;
      if (granted === undefined) {
        runtime.write(`${headline} attached: engine exit ${result.engineExit}.\n`);
        return result.engineExit;
      }
      runtime.write(detachedDispatchAnswer(headline, granted));
      return 0;
    } catch (error) {
      console.error(`✗ /go --scout dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  try {
    const result = await dispatchGo(
      {
        ensureLabel: (name) => runtime.ensureLabel(name),
        createIssue: (spec: DisposableIssueSpec) => runtime.createGoIssue(spec),
        runEngine,
      },
      parsed.demand,
      {
        runner: parsed.runner,
        mode: parsed.mode,
        yolo: parsed.yolo,
        task: parsed.demand,
        dod: parsed.dod,
        verifyCommand: parsed.verifyCommand,
        request: parsed.request,
        tags: parsed.tags,
        hasHarness: runtime.hasHarness,
      } satisfies { runner?: string; mode: GoMode; yolo: boolean } & GoDodSpec,
    );
    const headline =
      `🚀 /go dispatched disposable issue #${result.issue} ` +
      `(origin=go, kind=go, lane:go, mode=${parsed.mode}${parsed.yolo ? ", +yolo" : ""}).`;
    if (granted === undefined) {
      runtime.write(`${headline} attached: engine exit ${result.engineExit}.\n`);
      return result.engineExit;
    }
    runtime.write(detachedDispatchAnswer(headline, granted));
    return 0;
  } catch (error) {
    console.error(`✗ /go dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
