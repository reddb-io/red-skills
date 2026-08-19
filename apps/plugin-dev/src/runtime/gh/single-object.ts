// gh/single-object.ts — the one place a single-object read is ISSUED.
//
// `@reddb-io/github` decides that one issue or one pull request read by number
// belongs on REST (ADR 0132 decision 4). That decision changes nothing until
// somebody issues it there: `gh issue view --json state,labels` runs a GraphQL
// query no matter what a classifier believes, and it was the hot path — polled
// per Worker per iteration — that drained the node-point pool to `0/5000` while
// the request pool sat at `4891/5000`.
//
// **The fallback is a declared field gap, never an unclassified guess.** A read
// whose fields have no single-request REST projection (`comments` is a count in
// REST, not a list; `statusCheckRollup` is two further requests) keeps gh's own
// GraphQL command, and {@link readSingleObject} reports which surface answered so
// a caller or a test can see it. What never happens is the old default: an
// operation nobody classified silently inheriting GraphQL.

import { planGithubRestRead, type GithubApiSurface, type GithubSingleObjectKind } from "@reddb-io/github";
import type { ExecOutput } from "../exec.js";
import { repoArgs, runGh, type GhContext, type RunGhOpts } from "./common.js";

/** One single-object read: the raw exec outcome plus the projected `--json` row. */
export interface SingleObjectRead {
  readonly out: ExecOutput;
  /** Which API answered. `graphql` only when a requested field has no REST projection. */
  readonly surface: GithubApiSurface;
  /**
   * The requested fields in the shape `gh <kind> view --json <fields>` prints, or
   * `null` when the call failed or answered something unparseable. A failed read
   * is NEVER an empty row (#2801).
   */
  readonly row: Record<string, unknown> | null;
  /** Set when REST could not answer: the fields that blocked it, named. */
  readonly restUnavailable?: string;
}

/** gh's own subcommand for the object kind, used only when REST cannot answer. */
function viewArgs(
  ctx: GhContext,
  kind: GithubSingleObjectKind,
  number: number,
  fields: readonly string[],
): string[] {
  return [kind === "issue" ? "issue" : "pr", "view", String(number), ...repoArgs(ctx), "--json", fields.join(",")];
}

/**
 * Read one issue or one pull request by number, on the surface the router chose.
 * Never throws on a gh failure — the caller branches on `out.code` and `row`, the
 * way every reader in this tree already does.
 */
export async function readSingleObject(
  ctx: GhContext,
  kind: GithubSingleObjectKind,
  number: number,
  fields: readonly string[],
  runOpts: RunGhOpts = {},
): Promise<SingleObjectRead> {
  const plan = planGithubRestRead({ kind, number, fields, ...(ctx.repo ? { repo: ctx.repo } : {}) });
  if (plan.outcome === "plan") {
    const out = await runGh(ctx, plan.args, runOpts);
    if (out.code !== 0) return { out, surface: "rest", row: null };
    try {
      return { out, surface: "rest", row: plan.decode(out.stdout) };
    } catch {
      return { out, surface: "rest", row: null };
    }
  }
  const out = await runGh(ctx, viewArgs(ctx, kind, number, fields), runOpts);
  const failed = { out, surface: "graphql" as const, row: null, restUnavailable: plan.reason };
  if (out.code !== 0) return failed;
  try {
    const parsed: unknown = JSON.parse(out.stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return failed;
    return { out, surface: "graphql", row: parsed as Record<string, unknown>, restUnavailable: plan.reason };
  } catch {
    return failed;
  }
}
