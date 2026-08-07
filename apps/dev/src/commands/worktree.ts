/**
 * `red-skills-dev worktree <slug|#issue> [options]` — create a task worktree in
 * a registered lane, off a remote ref.
 *
 * Host CLIs are growing their own `--worktree` flags, and the ergonomics are the
 * point: one word instead of the three-part `git worktree add` this repo's
 * workflow prescribes. But a host flag lands where the HOST decides, in a lane
 * no janitor reclaims and no doctor reported until the audit beside this file
 * started reading git's own inventory. This is the same convenience, landing in
 * a lane we own — and it serves every runner, including the ones with no flag.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createGithubAttributionLedger, createGithubClient } from "@reddb-io/github";
import { stateDir } from "@reddb-io/shared/red-paths.js";
import { resolveRepoContext } from "../runtime/wire.js";
import { configFile } from "@reddb-io/shared/red-paths.js";
import { auditConfigLoad, getConfig } from "../core/config.js";
import { execTool } from "../runtime/exec.js";
import { issueNumberOf, planWorktree, type WorktreeLane } from "../core/worktree-plan.js";
import { REGISTERED_WORKTREE_LANES } from "../core/worktree-lane-doctor.js";

export const WORKTREE_USAGE = `Usage: red-skills-dev worktree <slug|#issue> [options]

Creates a task worktree under .red/tmp/worktrees/<lane>/ and branches it off a
REMOTE ref, which is the part a hand-written 'git worktree add' gets wrong: the
bare two-argument form resolves the LOCAL branch, so the work builds on a stale
tip and only the refused push says so.

Options:
  --lane <name>      ${REGISTERED_WORKTREE_LANES.join(", ")} (default: manual)
  --branch <name>    branch to create (default: afk/<slug>)
  --checkout <name>  check out an EXISTING branch from origin instead
  --base <ref>       base for a new branch (default: origin/<trunk>)
  --root <dir>       repository to create in (default: cwd)
  --print            print the plan and exit without touching git`;

interface ParsedArgs {
  readonly target?: string;
  readonly lane?: string;
  readonly branch?: string;
  readonly checkout?: string;
  readonly base?: string;
  readonly root?: string;
  readonly print: boolean;
}

function parse(args: readonly string[]): ParsedArgs {
  const out: Record<string, string> = {};
  let print = false;
  let target: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--print") print = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = args[++i] ?? "";
    else if (target === undefined) target = arg;
  }
  return { ...out, ...(target === undefined ? {} : { target }), print };
}

/**
 * The issue title, when the tracker can be asked. Absence is never a failure —
 * the title only makes the slug readable, and refusing without one would send
 * the caller back to the hand-written command this exists to replace.
 *
 * Routed through the house client (ADR 0132), not `gh`: one budget, one cache,
 * one attribution ledger. Resolving the credential is the stated bootstrap
 * exemption — the routed client cannot ask GitHub before there is a token.
 */
async function issueTitle(root: string, slug: string, issue: number): Promise<string | undefined> {
  if (slug === "") return undefined;
  const [owner, repo] = slug.split("/");
  if (owner === undefined || repo === undefined) return undefined;
  const token = readTrackerToken();
  if (token === null) return undefined;
  try {
    const client = createGithubClient({
      token,
      attribution: createGithubAttributionLedger({ path: join(stateDir(root), "github", "spend.toonl") }),
    });
    const answer = await client.conditionalRest<{ title?: string }>({
      cacheKey: `worktree:issue-title:${slug}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
      parameters: { owner, repo, issue_number: issue },
      operation: { key: "issue view", budget: "rest" },
      actor: "worktree",
    });
    const title = answer.data?.title?.trim() ?? "";
    return title === "" ? undefined : title;
  } catch {
    return undefined;
  }
}

/** The tracker credential. Authentication is not itself a GitHub read. */
function readTrackerToken(): string | null {
  const fromEnv = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export async function worktreeCommand(args: readonly string[]): Promise<number> {
  const parsed = parse(args);
  if (parsed.target === undefined || parsed.target === "--help") {
    process.stdout.write(`${WORKTREE_USAGE}\n`);
    return parsed.target === undefined ? 1 : 0;
  }
  if (parsed.lane !== undefined && !REGISTERED_WORKTREE_LANES.includes(parsed.lane)) {
    process.stderr.write(
      `unknown lane "${parsed.lane}"; registered lanes are ${REGISTERED_WORKTREE_LANES.join(", ")}\n`,
    );
    return 1;
  }

  const ctx = await resolveRepoContext(parsed.root);
  // The trunk is the repo's, not this command's: `plugins.dev.trunk` moves the
  // focal branch, and a worktree branched off the wrong one is invisible until
  // the PR shows a diff nobody asked for.
  const trunk = getConfig(auditConfigLoad(configFile(ctx.root)).values, "dev.trunk");
  const issue = issueNumberOf(parsed.target);
  const title = issue === null || parsed.checkout !== undefined
    ? undefined
    : await issueTitle(ctx.root, ctx.repo, issue);

  const plan = planWorktree({
    target: parsed.target,
    ...(parsed.lane === undefined ? {} : { lane: parsed.lane as WorktreeLane }),
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
    ...(parsed.checkout === undefined ? {} : { checkout: parsed.checkout }),
    ...(parsed.base === undefined ? {} : { base: parsed.base }),
    ...(trunk === "" ? {} : { trunk }),
    ...(title === undefined ? {} : { issueTitle: title }),
  });

  if (parsed.print) {
    process.stdout.write(`${["git", ...plan.argv].join(" ")}\n`);
    return 0;
  }

  // Fetch first, always. The base is a remote ref by construction, and a remote
  // ref this checkout has never seen is the other way the bare form fails.
  const fetchRef = plan.existing ? plan.branch : plan.base.replace(/^origin\//, "");
  const fetched = await execTool("git", ["fetch", "origin", fetchRef], { cwd: ctx.root });
  if (fetched.code !== 0) {
    process.stderr.write(`git fetch origin ${fetchRef} failed: ${fetched.stderr.trim()}\n`);
    return fetched.code;
  }

  // Run from the ROOT, never from the caller's directory: the command guard
  // resolves its allowed root from the current one, so a run started inside
  // another worktree nests this one inside it.
  const added = await execTool("git", plan.argv, { cwd: ctx.root });
  if (added.code !== 0) {
    process.stderr.write(added.stderr.trim() === "" ? "git worktree add failed\n" : `${added.stderr.trim()}\n`);
    return added.code;
  }

  process.stdout.write(`${plan.directory}\n`);
  process.stderr.write(`branch ${plan.branch} from ${plan.base}\n`);
  return 0;
}
