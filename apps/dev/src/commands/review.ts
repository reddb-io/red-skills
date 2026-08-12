// commands/review.ts — the IO half of `dev review --pr N` (PRD #745, issue #746).
//
// The advisory cloud PR review. Wired from a thin `pull_request: labeled`
// (== `ready-for-review`) event-router workflow that fetches the versioned dev
// bundle and calls this subcommand; the binary owns all logic. It runs the
// vendored sandcastle review engine under the configured provider (OpenCode/
// MiniMax on the cloud lane), posts inline comments + a summary back through our
// `gh` runtime, and transitions the PR through the shared lifecycle labels. It
// never pushes code and the workflow requests no `contents: write`.

import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { Output } from "@reddb-io/red-castle";
import { execTool } from "../runtime/exec.js";
import { loadConfig, getConfig, resolveTier } from "../core/config.js";
import { resolveConfigPath } from "./route-model-tier.js";
import { defaultSandcastleDeps, type AgentRunner } from "../core/execution.js";
import { runReview, type ReviewResult } from "../core/review.js";
import { makeExtractReview, reviewFindingsSchema } from "../core/review-extract.js";
import { buildReviewGh } from "../runtime/review-gh.js";
import { actorTrustSignals, type GhContext } from "../runtime/gh.js";
import { parseTrustPolicy, resolveActorTrust } from "../core/trust-gate.js";
import { inferGitHubRepoSlug } from "../runtime/wire/github-slug.js";

const REVIEW_FLAG_SCHEMA = {
  pr: { kind: "value", coerce: (raw: string): number => Number(raw) },
  runner: { kind: "value", coerce: (raw: string): string => raw },
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  root: { kind: "value", coerce: (raw: string): string => raw },
} satisfies FlagSchema;

function isRunner(value: string): value is AgentRunner {
  return value === "claude" || value === "codex" || value === "opencode";
}

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  return inferGitHubRepoSlug(cwd);
}

/**
 * `review --pr N [--runner R] [--repo owner/repo]` — run the advisory review for
 * one PR. Resolves the provider (flag → `afk.default_runner`) and its `complex`
 * model tier, builds the sandcastle-backed extraction (with the structured-output
 * retry budget) and the `gh` write-back, then runs the advisory pass.
 */
export async function reviewCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const { values } = parseFlags(args, REVIEW_FLAG_SCHEMA);
  const pr = Number(values.pr);
  if (!Number.isInteger(pr) || pr <= 0) {
    process.stderr.write("[afk] review requires --pr <number>\n");
    return 2;
  }
  const root = (values.root as string | undefined)?.trim() || cwd;

  const config = loadConfig(resolveConfigPath(root), { warn: () => undefined });
  const flagRunner = values.runner as string | undefined;
  const configRunner = getConfig(config, "afk.default_runner") || "claude";
  const runnerCandidate = flagRunner ?? configRunner;
  const runner: AgentRunner = isRunner(runnerCandidate) ? runnerCandidate : "claude";

  const repo = await resolveRepo(root, values.repo as string | undefined);
  const ghCtx: GhContext = { cwd: root, repo };
  const policy = parseTrustPolicy(config);

  const tier = resolveTier(config, runner, "complex", process.env);
  const sandcastle = await defaultSandcastleDeps();
  const extractReview = makeExtractReview(
    {
      run: sandcastle.run as Parameters<typeof makeExtractReview>[0]["run"],
      agentFor: sandcastle.agentFor,
      sandboxFor: (mode) => sandcastle.sandboxFor(mode),
      output: ({ tag, maxRetries }) => Output.object({ tag, schema: reviewFindingsSchema, maxRetries }),
      cwd: root,
    },
    { model: tier.model, effort: tier.effort },
  );

  let result: ReviewResult;
  try {
    result = await runReview(
      {
        gh: buildReviewGh(ghCtx, (actor) => resolveActorTrust(policy, actor, (login) => actorTrustSignals(ghCtx, login))),
        extractReview,
        log: (m) => process.stderr.write(`${m}\n`),
      },
      { pr, runner },
    );
  } catch (error) {
    process.stderr.write(`[afk] review failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  stdout.write(
    `Review #${pr}: ${result.verdict} (${result.postedComments} inline comment(s)${result.posted ? ", posted" : ""}).\n`,
  );
  return 0;
}
