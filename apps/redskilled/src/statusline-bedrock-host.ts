/**
 * statusline-bedrock-host — the daemon's half of the bedrock, resolved from the
 * calling host and nothing else.
 *
 * **The daemon command owns BOTH halves of the line now.** ADR 0141 §1 split the
 * statusline by data ownership — the Bedrock (Claude Code's stdin payload, local
 * git under a ~5s micro-TTL, the running bundle version) answers with zero
 * network and zero daemon, while the tail is the daemon's own document. That
 * bedrock shipped inside the dev bundle ADR 0147 deleted, and PR #4272 pointed
 * the host's `statusLine.command` at the `redskilled` bundle, which rendered the
 * tail alone: the operator's bar lost model, branch and context. This module is
 * the adapter that puts them back, on the producer that survived.
 *
 * **Every reach here is absent-tolerant, because the bedrock's whole point is
 * that it still renders.** No stdin, malformed stdin, no git, no repository, an
 * unreadable cache — each degrades to fewer facts on the line, never to a stall
 * and never to a throw. The render itself is pure and lives one layer down
 * (`@reddb-io/shared/statusline-bedrock.js`, `@reddb-io/redskilled-render/bedrock-style.js`);
 * this module decides only WHICH facts reached it and whether they get painted.
 */
import { readBuildInfo } from "@reddb-io/build-info";
import {
  composeStatuslineLines,
  renderStatuslineBedrock,
  type ClaudeInput,
  type ProjectInput,
  type StatuslineBedrockInput,
} from "@reddb-io/shared/statusline-bedrock.js";
import {
  collectStatuslineLocalGit,
  type StatuslineLocalGit,
  type StatuslineLocalGitDeps,
} from "@reddb-io/shared/statusline-local-git.js";
import {
  readStatuslineStdinPayload,
  type ReadStatuslineStdinOptions,
  type StatuslineStdinPayload,
} from "@reddb-io/shared/statusline-stdin.js";
import { renderStatuslineBedrockThemed } from "@reddb-io/redskilled-render/bedrock-style.js";

/** The seams a test poses as; production passes none of them. */
export interface StatuslineBedrockIO {
  /** The directory the command was invoked in, before stdin gets a say. */
  readonly cwd?: string;
  /** How the host payload is read; a test supplies a fake stream or a payload. */
  readonly readStdin?: (
    options?: ReadStatuslineStdinOptions,
  ) => Promise<StatuslineStdinPayload | null>;
  /** How the local git facts are read. */
  readonly readLocalGit?: (
    root: string,
    deps?: StatuslineLocalGitDeps,
  ) => Promise<StatuslineLocalGit>;
  /** The running bundle version; read off the build stamp when absent. */
  readonly version?: string;
  /** The environment the colour decision is taken from. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the bedrock's inputs: the host payload decides the model, context and
 * usage blocks AND (through `workspace.current_dir`) which directory the git
 * facts are read from, because the session's directory is the session's, not the
 * one the statusline process happened to be spawned in.
 */
export async function collectStatuslineBedrockInput(
  io: StatuslineBedrockIO = {},
): Promise<StatuslineBedrockInput> {
  const payload = await (io.readStdin ?? readStatuslineStdinPayload)();
  const root = payload?.cwd ?? io.cwd ?? process.cwd();
  const git = await (io.readLocalGit ?? collectStatuslineLocalGit)(root);
  const version = io.version ?? readBuildInfo("redskilled").version;

  const project: ProjectInput = { basename: git.basename };
  if (git.branch) project.branch = git.branch;
  else if (git.detachedSha) project.detachedSha = git.detachedSha;
  if (version) project.version = version;

  const claude: ClaudeInput | undefined = payload?.claude;
  const input: StatuslineBedrockInput = {
    project,
    localDiff: { localAdded: git.localAdded, localRemoved: git.localRemoved },
  };
  if (claude !== undefined) input.claude = claude;
  return input;
}

/**
 * The bedrock line, painted unless `NO_COLOR` is set.
 *
 * TTY is deliberately NOT consulted: Claude Code reads the statusline off a
 * pipe and renders the escapes itself, so a TTY probe would strip the colour on
 * exactly the surface that wants it. `NO_COLOR` is the operator's own word and
 * is the only thing that mutes the paint — the same rule the dashboard follows.
 */
export function renderStatuslineBedrockLine(
  input: StatuslineBedrockInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.NO_COLOR !== undefined
    ? renderStatuslineBedrock(input)
    : renderStatuslineBedrockThemed(input);
}

/**
 * The whole line: the bedrock this host can always answer, then the daemon tail
 * the shared render produced. A tail that produced nothing leaves the bedrock
 * alone rather than a dangling separator — an unreachable daemon costs the
 * operator the tail, never the facts their own machine already holds.
 */
export async function composeStatuslineWithBedrock(
  tail: readonly string[],
  io: StatuslineBedrockIO = {},
): Promise<string[]> {
  const input = await collectStatuslineBedrockInput(io);
  return composeStatuslineLines(renderStatuslineBedrockLine(input, io.env ?? process.env), tail);
}
