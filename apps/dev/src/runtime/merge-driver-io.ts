import type { MergeDriverIo, MergeDriverPrView } from "@reddb-io/red-castle/engine";
import { planGithubWrite } from "@reddb-io/github";
import type { GithubMergeRead } from "../core/github-merge-read.js";
import { apiPath, runGh, type GhContext } from "./gh/common.js";

interface CheckRow {
  status?: string;
  state?: string;
  conclusion?: string | null;
}

/** Fold a statusCheckRollup into the driver's three-valued checks signal. */
export function foldChecks(rollup: readonly CheckRow[]): MergeDriverPrView["checks"] {
  let pending = false;
  for (const row of rollup) {
    const status = (row.status ?? row.state ?? "").toUpperCase();
    const conclusion = (row.conclusion ?? "").toUpperCase();
    if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || conclusion === "ACTION_REQUIRED") {
      pending = true;
      continue;
    }
    if (
      conclusion === "FAILURE" ||
      conclusion === "CANCELLED" ||
      conclusion === "TIMED_OUT" ||
      conclusion === "STARTUP_FAILURE" ||
      status === "FAILURE" ||
      status === "ERROR"
    ) {
      return "failing";
    }
  }
  return pending ? "pending" : "green";
}

/** The dev-host implementation of the castle merge driver's IO port: a routed
 * conditional REST read for ground truth, the REST update-branch endpoint when BEHIND, and
 * `gh pr merge --merge` — the merge-commit strategy, never `--admin`. */
export function createMergeDriverIo(ctx: GhContext, github: GithubMergeRead): MergeDriverIo {
  return {
    async viewPr(pr) {
      const parsed = JSON.parse(await github.driverPr(ctx.repo, pr)) as {
        state?: string;
        mergeStateStatus?: string;
        statusCheckRollup?: CheckRow[] | null;
      };
      const state = (parsed.state ?? "OPEN").toUpperCase();
      return {
        state: state === "MERGED" ? "MERGED" : state === "CLOSED" ? "CLOSED" : "OPEN",
        mergeStateStatus: (parsed.mergeStateStatus ?? "UNKNOWN").toUpperCase(),
        checks: foldChecks(parsed.statusCheckRollup ?? []),
      };
    },
    async updateBranch(pr) {
      const plan = planGithubWrite(["gh", "api", "-X", "PUT", apiPath(ctx, `pulls/${pr}/update-branch`)]);
      const r = await runGh(ctx, plan.args.slice(1));
      if (r.code !== 0) throw new Error(`update-branch #${pr} failed: ${r.stderr.trim()}`);
    },
    async merge(pr, strategy) {
      const plan = planGithubWrite(["gh", "-R", ctx.repo, "pr", "merge", String(pr), `--${strategy}`]);
      const r = await runGh(ctx, plan.args.slice(1));
      if (r.code !== 0) throw new Error(`merge #${pr} failed: ${r.stderr.trim()}`);
    },
  };
}
