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
import { execTool, type ExecFn, type ExecOptions, type ExecOutput } from "./exec.js";
import type { GhContext } from "./gh.js";
import type { InlineComment, PrContext, ReviewGh } from "../core/review.js";
import { classifySourceTrust, TRUSTED_ASSOCIATIONS } from "../core/source-trust.js";
import type { ActorTrustVerdict } from "../core/trust-gate.js";

function runGh(ctx: GhContext, args: readonly string[]): Promise<ExecOutput> {
  const opts: ExecOptions = { cwd: ctx.cwd };
  return (ctx.exec ?? execTool)("gh", args, opts);
}

function repoArgs(ctx: GhContext): string[] {
  return ctx.repo ? ["--repo", ctx.repo] : [];
}

type PrTrustResolver = (actor: string) => Promise<ActorTrustVerdict>;

/** Build the {@link ReviewGh} port over a {@link GhContext}. */
export function buildReviewGh(ctx: GhContext, resolveTrust?: PrTrustResolver): ReviewGh {
  return {
    async fetchPr(pr: number): Promise<PrContext> {
      const view = await runGh(ctx, ["pr", "view", String(pr), ...repoArgs(ctx), "--json", "title,body,author,authorAssociation"]);
      let title = "";
      let body = "";
      let login: string | undefined;
      let isBot = false;
      let authorAssociation: string | undefined;
      if (view.code === 0) {
        try {
          const parsed = JSON.parse(view.stdout) as {
            title?: string;
            body?: string | null;
            author?: { login?: string; is_bot?: boolean };
            authorAssociation?: string;
          };
          title = parsed.title ?? "";
          body = parsed.body ?? "";
          login = parsed.author?.login ? String(parsed.author.login) : undefined;
          isBot = parsed.author?.is_bot === true;
          authorAssociation = parsed.authorAssociation ? String(parsed.authorAssociation) : undefined;
        } catch {
          // tolerate malformed JSON — degrade to empty metadata.
        }
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
      const diff = await runGh(ctx, ["pr", "diff", String(pr), ...repoArgs(ctx)]);
      return {
        number: pr,
        title,
        body,
        sourceTrust: classifySourceTrust({ authorAssociation, isBot, trustVerdict }),
        diff: diff.code === 0 ? diff.stdout : "",
      };
    },

    async postReview(pr, payload) {
      // The reviews endpoint takes a nested `comments` array, so the request body
      // goes through a temp JSON file consumed by `gh api --input`.
      const reviewBody = {
        event: "COMMENT" as const,
        body: payload.summary,
        comments: payload.comments.map((c: InlineComment) => ({
          path: c.path,
          line: c.line,
          side: "RIGHT" as const,
          body: c.body,
        })),
      };
      const dir = mkdtempSync(join(tmpdir(), "red-review-"));
      const file = join(dir, "review.json");
      try {
        writeFileSync(file, JSON.stringify(reviewBody));
        const path = ctx.repo ? `repos/${ctx.repo}/pulls/${pr}/reviews` : `pulls/${pr}/reviews`;
        await runGh(ctx, ["api", "-X", "POST", path, "--input", file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async comment(pr, body) {
      await runGh(ctx, ["pr", "comment", String(pr), ...repoArgs(ctx), "--body", body]);
    },

    async ensureLabel(name) {
      await runGh(ctx, [
        "label",
        "create",
        name,
        ...repoArgs(ctx),
        "--color",
        "5319E7",
        "--description",
        "AFK PR-review lifecycle label",
      ]);
    },

    async editLabels(pr, remove, add) {
      const args = ["pr", "edit", String(pr), ...repoArgs(ctx)];
      for (const label of remove) args.push("--remove-label", label);
      for (const label of add) args.push("--add-label", label);
      const r = await runGh(ctx, args);
      return r.code === 0;
    },
  };
}
