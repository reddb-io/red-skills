// runtime/review-gh.ts — concrete `ReviewGh` closures backed by exec.ts.
//
// The advisory review's write-back surface (issue #746): read a PR + its diff,
// post a single PR review (summary + path+line inline comments), edit labels,
// and post a degraded top-level comment. Every call routes through the same
// `gh` exec seam as runtime/gh.ts, so a test can drive the real closure
// assembly with a recording fake (no OS). It carries NO push/merge primitive —
// the review never mutates code.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planGithubWrite } from "@reddb-io/github";
import { execTool, type ExecFn, type ExecOptions, type ExecOutput } from "./exec.js";
import type { GhContext } from "./gh.js";
import { githubReadClient, githubRepo } from "./gh/common.js";
import type { InlineComment, PrContext, ReviewGh } from "../core/review.js";
import { classifySourceTrust, TRUSTED_ASSOCIATIONS } from "../core/source-trust.js";
import type { ActorTrustVerdict } from "../core/trust-gate.js";
import { scrubOutbound } from "./outbound-redaction.js";

function runGh(ctx: GhContext, args: readonly string[]): Promise<ExecOutput> {
  const opts: ExecOptions = { cwd: ctx.cwd };
  return (ctx.exec ?? execTool)("gh", args, opts);
}

function repoArgs(ctx: GhContext): string[] {
  return ctx.repo ? ["--repo", ctx.repo] : [];
}

async function readPull<T>(ctx: GhContext, pr: number, cacheKey: string, accept?: string): Promise<T | null> {
  const repo = githubRepo(ctx);
  if (!repo) return null;
  try {
    const answer = await githubReadClient(ctx).conditionalRest<T>({
      cacheKey: `review:${ctx.repo}:${pr}:${cacheKey}`,
      route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      parameters: {
        ...repo,
        pull_number: pr,
        ...(accept ? { headers: { accept } } : {}),
      },
      operation: { key: cacheKey === "diff" ? "pr diff" : "pr view", budget: "rest" },
      actor: "review",
    });
    return answer.data;
  } catch {
    return null;
  }
}

type PrTrustResolver = (actor: string) => Promise<ActorTrustVerdict>;

/** Build the {@link ReviewGh} port over a {@link GhContext}. */
export function buildReviewGh(ctx: GhContext, resolveTrust?: PrTrustResolver): ReviewGh {
  return {
    async fetchPr(pr: number): Promise<PrContext> {
      const view = await readPull<{
        title?: string;
        body?: string | null;
        user?: { login?: string; type?: string };
        author_association?: string;
      }>(ctx, pr, "metadata");
      let title = "";
      let body = "";
      let login: string | undefined;
      let isBot = false;
      let authorAssociation: string | undefined;
      if (view) {
        title = view.title ?? "";
        body = view.body ?? "";
        login = view.user?.login ? String(view.user.login) : undefined;
        isBot = view.user?.type?.toLowerCase() === "bot";
        authorAssociation = view.author_association ? String(view.author_association) : undefined;
      }
      const associationTrusted = TRUSTED_ASSOCIATIONS.has((authorAssociation ?? "").trim().toUpperCase());
      let trustVerdict: ActorTrustVerdict | undefined;
      if (!isBot && !associationTrusted && login && resolveTrust) {
        try {
          trustVerdict = await resolveTrust(login);
        } catch {
          trustVerdict = undefined;
        }
      }
      const diff = await readPull<string>(ctx, pr, "diff", "application/vnd.github.v3.diff");
      return {
        number: pr,
        title,
        body,
        sourceTrust: classifySourceTrust({ authorAssociation, isBot, trustVerdict }),
        diff: typeof diff === "string" ? diff : "",
      };
    },

    async postReview(pr, payload) {
      // The reviews endpoint takes a nested `comments` array, so the request body
      // goes through a temp JSON file consumed by `gh api --input`.
      const reviewBody = {
        event: "COMMENT" as const,
        body: scrubOutbound(payload.summary),
        comments: payload.comments.map((c: InlineComment) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT" as const,
          body: scrubOutbound(c.body),
        })),
      };
      const dir = mkdtempSync(join(tmpdir(), "red-review-"));
      const file = join(dir, "review.json");
      try {
        writeFileSync(file, JSON.stringify(reviewBody));
        const path = ctx.repo ? `repos/${ctx.repo}/pulls/${pr}/reviews` : `pulls/${pr}/reviews`;
        const plan = planGithubWrite(["gh", "api", "-X", "POST", path, "--input", file]);
        await runGh(ctx, plan.args.slice(1));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async comment(pr, body) {
      const plan = planGithubWrite(["gh", "pr", "comment", String(pr), ...repoArgs(ctx), "--body", scrubOutbound(body)]);
      await runGh(ctx, plan.args.slice(1));
    },

    async ensureLabel(name) {
      const plan = planGithubWrite(["gh",
        "label",
        "create",
        name,
        ...repoArgs(ctx),
        "--color",
        "5319E7",
        "--description",
        "AFK PR-review lifecycle label",
      ]);
      await runGh(ctx, plan.args.slice(1));
    },

    async editLabels(pr, remove, add) {
      const args = ["gh", "pr", "edit", String(pr), ...repoArgs(ctx)];
      for (const label of remove) args.push("--remove-label", label);
      for (const label of add) args.push("--add-label", label);
      const current = await readPull<{ labels?: Array<{ name?: string }> }>(ctx, pr, "labels");
      const currentIssueLabels = current?.labels?.map((label) => String(label.name ?? ""));
      const plan = planGithubWrite(args, currentIssueLabels ? { currentIssueLabels } : {});
      const r = await runGh(ctx, plan.args.slice(1));
      return r.code === 0;
    },
  };
}
