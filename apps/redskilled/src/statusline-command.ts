/**
 * statusline-command — `redskilled statusline`, importable without the CLI.
 *
 * It sits apart from `cli.ts` because that module ends in a self-invocation
 * guard, and inside a single-file bundle the guard is ALWAYS true: every inlined
 * module shares the bundle's own `import.meta.url`, which is exactly
 * `process.argv[1]`. A consumer that imported `runStatusline` from the CLI
 * therefore shipped a second, argv-reading CLI inside its own binary — the
 * redskilled-mcp canary caught it as a host-state document splashed across a stdout
 * that must carry one TOON report (#3546). A command another package may import
 * lives in a module that runs nothing on import.
 *
 * The command's contract is unchanged from where it lived: config is read HERE,
 * on the client side, and only decided values reach the render; it always writes
 * a line and always exits 0, because a statusline that printed nothing when the
 * daemon was down would render an outage as calm. An unreachable host is a
 * stated absence on stdout and a diagnosis on stderr.
 *
 * **This command owns BOTH halves of the line** (ADR 0141 §1). The Bedrock —
 * model, directory, branch, context, the running version — is drawn from the
 * Claude Code stdin payload and local git, with zero network and zero daemon,
 * and LEADS the header the daemon tail supplies. It shipped inside the dev
 * bundle ADR 0147 deleted, so between that deletion and its arrival here the
 * operator's bar carried the tail alone; the seam is one process now, which is
 * what the ADR meant by the bedrock/tail seam being permanent.
 */
import {
  readRedskilledStatuslineRender,
  type RedskilledClientConfig,
} from "./client.js";
import { probeRedskilledStatuslinePayload } from "./statusline-probe.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import {
  parseRedskilledStatuslineFlags,
  resolveRedskilledStatuslineOptions,
} from "./statusline-config.js";
import { readStatuslineProject } from "./statusline-project.js";
import type { RedskilledStatuslinePayload } from "./statusline-payload.js";
import {
  renderRedskilledStatusline,
  renderRedskilledStatuslineAbsence,
  type RedskilledStatuslineRender,
} from "@reddb-io/redskilled-render";
import {
  composeStatuslineWithBedrock,
  type StatuslineBedrockIO,
} from "./statusline-bedrock-host.js";

export interface RedskilledStatuslineProbe {
  readonly payload: RedskilledStatuslinePayload;
  readonly render: RedskilledStatuslineRender;
}

/**
 * Read one already-running daemon and return both its payload and Shared render.
 *
 * This is the importable seam for prompt hosts that need lifecycle facts beside
 * the rendered tail. It is probe-only by construction: unlike `runStatusline`,
 * it never enters the client's daemon-start path.
 */
export async function probeStatusline(
  args: readonly string[],
  io: {
    readonly cwd?: string;
    readonly paths?: RedskilledPaths;
    readonly warn?: (line: string) => void;
    readonly client?: RedskilledClientConfig;
  } = {},
): Promise<RedskilledStatuslineProbe> {
  const warn = io.warn ?? ((line: string) => process.stderr.write(line));
  const parsed = parseRedskilledStatuslineFlags(args);
  const project = readStatuslineProject(io.cwd ?? process.cwd());
  const resolved = resolveRedskilledStatuslineOptions({
    ...(project.configText == null ? {} : { configText: project.configText }),
    project: project.label,
    flags: parsed.flags,
  });
  for (const warning of [...resolved.warnings, ...parsed.warnings]) {
    warn(`redskilled statusline: ignoring ${warning.key}=${warning.value} — ${warning.reason}\n`);
  }
  const payload = await probeRedskilledStatuslinePayload(
    io.paths ?? resolveRedskilledPaths(),
    {
      ...(io.client ?? {}),
      ...(resolved.options.project == null ? {} : { sessionProject: resolved.options.project }),
    },
    { vitals: true, logs: resolved.options.verbose, display: true },
  );
  return { payload, render: renderRedskilledStatusline(payload, resolved.options) };
}

export async function runStatusline(
  args: readonly string[],
  io: {
    readonly cwd?: string;
    /** The session's socket; derived from the environment when absent. */
    readonly paths?: RedskilledPaths;
    readonly write?: (line: string) => void;
    readonly warn?: (line: string) => void;
    /** How to reach the daemon; injected so a test can pose as a dead host. */
    readonly client?: RedskilledClientConfig;
    /** The clock, for the one instant no daemon supplies: an absence's own. */
    readonly now?: () => string;
    /** The bedrock's own seams — the host payload, local git, the build stamp. */
    readonly bedrock?: StatuslineBedrockIO;
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line));
  const warn = io.warn ?? ((line: string) => process.stderr.write(line));

  const parsed = parseRedskilledStatuslineFlags(args);
  const project = readStatuslineProject(io.cwd ?? process.cwd());
  const resolved = resolveRedskilledStatuslineOptions({
    ...(project.configText == null ? {} : { configText: project.configText }),
    project: project.label,
    flags: parsed.flags,
  });
  for (const warning of [...resolved.warnings, ...parsed.warnings]) {
    warn(`redskilled statusline: ignoring ${warning.key}=${warning.value} — ${warning.reason}\n`);
  }

  let render;
  try {
    render = await readRedskilledStatuslineRender(io.paths ?? resolveRedskilledPaths(), resolved.options, {
      ...(io.client ?? {}),
      ...(resolved.options.project == null ? {} : { sessionProject: resolved.options.project }),
    });
  } catch (err) {
    warn(`redskilled statusline: ${err instanceof Error ? err.message : String(err)}\n`);
    render = renderRedskilledStatuslineAbsence({
      options: resolved.options,
      generated_at: (io.now ?? (() => new Date().toISOString()))(),
    });
  }
  // Every line the shared render produced, in order — one write, whatever the
  // taste. With `--verbose` that is the Worker line plus a second line per
  // Worker; the host still decides nothing about shape.
  //
  // The bedrock LEADS the header. It is wrapped because it must never be able to
  // cost the tail: the whole reason this half exists is that it renders when the
  // other one cannot, and a bedrock that threw would invert that promise.
  let lines = render.lines;
  try {
    lines = await composeStatuslineWithBedrock(render.lines, {
      ...(io.cwd == null ? {} : { cwd: io.cwd }),
      ...(io.bedrock ?? {}),
    });
  } catch (err) {
    warn(`redskilled statusline: bedrock unavailable — ${err instanceof Error ? err.message : String(err)}\n`);
  }
  write(`${lines.join("\n")}\n`);
  return 0;
}
