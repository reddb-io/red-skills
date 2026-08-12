// commands/respond.ts — the IO half of `dev respond` (PRD #745, issue #750).
//
// The advisory comment responder. Wired from a thin `issue_comment` /
// `pull_request_review_comment` event-router workflow that fetches the versioned
// dev bundle and calls this subcommand with the parsed comment event as
// structured flags (`--body`, `--author`, `--number`, `--is-pr`, …). The binary
// owns all logic: parse the `/dev` summon, authorize the commenter through the
// #747 trust resolver, then route `/dev explain` (answer in-thread) or
// `/dev review` (delegate to the #746 advisory review path). It never pushes
// code and the workflow requests no `contents: write`.

import { Writable } from "node:stream";
import { planGithubWrite, routeGithubArgs } from "@reddb-io/github";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { Output } from "@reddb-io/red-castle";
import { execTool } from "../runtime/exec.js";
import { scrubOutbound } from "../runtime/outbound-redaction.js";
import { loadConfig, getConfig, resolveTier } from "../core/config.js";
import { resolveConfigPath } from "./route-model-tier.js";
import { defaultSandcastleDeps, type AgentRunner } from "../core/execution.js";
import { runRespond, type CommentEvent, type RespondGh, type RespondResult } from "../core/comment-respond.js";
import { makeExplain, explainAnswerSchema } from "../core/comment-respond-extract.js";
import { parseTrustPolicy, resolveActorTrust } from "../core/trust-gate.js";
import { actorTrustSignals, type GhContext } from "../runtime/gh.js";
import { reviewCommand } from "./review.js";
import { createDevGithubClient } from "../runtime/github-merge-read.js";
import { inferGitHubRepoSlug } from "../runtime/wire/github-slug.js";

const REPO_VIEW_OPERATION = routeGithubArgs(["repo", "view"]);

const RESPOND_FLAG_SCHEMA = {
  body: { kind: "value", coerce: (raw: string): string => raw },
  author: { kind: "value", coerce: (raw: string): string => raw },
  number: { kind: "value", coerce: (raw: string): number => Number(raw) },
  "is-pr": { kind: "boolean" },
  runner: { kind: "value", coerce: (raw: string): string => raw },
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  root: { kind: "value", coerce: (raw: string): string => raw },
} satisfies FlagSchema;

function isRunner(value: string): value is AgentRunner {
  return value === "claude" || value === "codex" || value === "opencode";
}

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const inferred = inferGitHubRepoSlug(cwd);
  const [owner, repo] = inferred.split("/");
  if (!owner || !repo) return "";
  try {
    const answer = await createDevGithubClient(cwd).conditionalRest<{ full_name?: string }>({
      cacheKey: `respond:repo:${inferred}`,
      route: "GET /repos/{owner}/{repo}",
      parameters: { owner, repo },
      operation: REPO_VIEW_OPERATION,
      actor: "respond",
    });
    return answer.data?.full_name?.trim() || "";
  } catch {
    return "";
  }
}

/** The parsed comment event the MCP `respond` op and the CLI command both feed to the value core. */
export interface RespondExecInput {
  body: string;
  number: number;
  author?: string;
  isPr?: boolean;
  runner?: string;
  repo?: string;
  root?: string;
}

/** Discards `/dev review` delegation output — the MCP path has no stdout to render to. */
const discardStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });

/**
 * Value-returning responder core: resolve the provider (flag → `afk.default_runner`)
 * and its `complex` model tier, wire the gh-backed reply + trust resolver + sandcastle
 * explainer, and dispatch the advisory route, returning the {@link RespondResult}. The
 * CLI command prints its prose line; the MCP `respond` op returns the result verbatim
 * (TOON-encoded at the transport boundary). `number` must already be a valid positive
 * integer. `/dev review` delegation renders to `opts.reviewStdout` (default: discard).
 */
export async function executeRespond(
  input: RespondExecInput,
  opts: { cwd?: string; reviewStdout?: NodeJS.WritableStream } = {},
): Promise<RespondResult> {
  const root = input.root?.trim() || opts.cwd || process.cwd();
  const reviewStdout = opts.reviewStdout ?? discardStream;
  const number = input.number;
  const body = input.body ?? "";
  const author = input.author?.trim() || undefined;
  const isPr = input.isPr === true;

  const config = loadConfig(resolveConfigPath(root), { warn: () => undefined });
  const configRunner = getConfig(config, "afk.default_runner") || "claude";
  const runnerCandidate = input.runner ?? configRunner;
  const runner: AgentRunner = isRunner(runnerCandidate) ? runnerCandidate : "claude";

  const repo = await resolveRepo(root, input.repo);
  const ghCtx: GhContext = { cwd: root, repo };

  const policy = parseTrustPolicy(config);
  const tier = resolveTier(config, runner, "complex", process.env);
  const sandcastle = await defaultSandcastleDeps();
  const explain = makeExplain(
    {
      run: sandcastle.run as Parameters<typeof makeExplain>[0]["run"],
      agentFor: sandcastle.agentFor,
      sandboxFor: (mode) => sandcastle.sandboxFor(mode),
      output: ({ tag, maxRetries }) => Output.object({ tag, schema: explainAnswerSchema, maxRetries }),
      cwd: root,
    },
    { model: tier.model, effort: tier.effort },
  );

  const gh: RespondGh = {
    async reply(target, replyBody) {
      const flag = isPr ? "pr" : "issue";
      const repoArgs = repo ? ["--repo", repo] : [];
      const plan = planGithubWrite([
        "gh", flag, "comment", String(target), ...repoArgs, "--body", scrubOutbound(replyBody),
      ]);
      const [command, ...args] = plan.args;
      await execTool(command!, args, { cwd: root });
    },
  };

  const event: CommentEvent = { body, author, number, isPr, runner };

  return runRespond(
    {
      gh,
      resolveTrust: (actor) => resolveActorTrust(policy, actor, (login) => actorTrustSignals(ghCtx, login)),
      explain,
      review: async () => {
        const reviewArgs = ["--pr", String(number), "--runner", runner];
        if (repo) reviewArgs.push("--repo", repo);
        if (root) reviewArgs.push("--root", root);
        await reviewCommand(reviewArgs, root, reviewStdout);
      },
      log: (m) => process.stderr.write(`${m}\n`),
    },
    event,
  );
}

/**
 * `respond --body <text> --author <login> --number N [--is-pr] [--runner R] [--repo owner/repo]`
 * — react to one comment event. Delegates to {@link executeRespond} and prints the
 * terminal action. A comment with no `/dev` summon exits 0 as a no-op.
 */
export async function respondCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const { values } = parseFlags(args, RESPOND_FLAG_SCHEMA);
  const number = Number(values.number);
  if (!Number.isInteger(number) || number <= 0) {
    process.stderr.write("[afk] respond requires --number <issue-or-pr-number>\n");
    return 2;
  }
  const root = (values.root as string | undefined)?.trim() || cwd;

  let result: RespondResult;
  try {
    result = await executeRespond(
      {
        body: (values.body as string | undefined) ?? "",
        number,
        author: values.author as string | undefined,
        isPr: values["is-pr"] === true,
        runner: values.runner as string | undefined,
        repo: values.repo as string | undefined,
        root,
      },
      { cwd, reviewStdout: stdout },
    );
  } catch (error) {
    process.stderr.write(`[afk] respond failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stdout.write(`Respond #${number}: ${result.action}${result.verb ? ` (/dev ${result.verb})` : ""}.\n`);
  return 0;
}
