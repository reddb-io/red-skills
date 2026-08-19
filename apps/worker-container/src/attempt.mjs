/**
 * One AFK run, start to finish: choose a runner, find a queue head, clone it
 * ephemerally, hand the issue to the engine, delete the clone.
 *
 * The engine (`red-skills-dev run --issues N --runner R --once`) owns the claim
 * comment, the heartbeat, the validation gate and the pull request. Nothing here
 * reimplements any of it, and nothing here persists: kill the container at any
 * point and the only residue is the claim comment on the issue, which the
 * engine's own stale-claim reconciliation reclaims.
 */

import { buildRunEnv } from "./config.mjs";
import { listReadyIssues, pickIssue, rotate } from "./queue.mjs";
import { selectRunner } from "./runners.mjs";

/**
 * @param {object} params
 * @param {object} params.config resolved container config
 * @param {number} params.cycle  0-based run counter, driving both round-robins
 * @param {object} params.env    process environment (credentials live here)
 * @param {object} params.io     side-effect seam: listIssues/makeWorkdir/clone/runEngine/cleanup
 * @param {(message: string) => void} params.log
 * @returns {Promise<{status: "worked"|"failed"|"empty"|"no-runner", repo?: string, issue?: number, runner?: string, exitCode?: number, skipped?: string[]}>}
 */
export async function runCycle({ config, cycle, env, io, log }) {
  const { runner, skipped } = selectRunner(config.cadence, cycle, env);
  if (skipped.length > 0) {
    log(`runner ${skipped.join(", ")} skipped — no credential in this environment`);
  }
  if (!runner) {
    log(`no cadence runner is credentialed (cadence: ${config.cadence.join(", ")})`);
    return { status: "no-runner", skipped };
  }

  for (const repo of rotate(config.repos, cycle)) {
    const issues = await io.listIssues({ repo, label: config.label });
    const issue = pickIssue(issues);
    if (!issue) {
      log(`${repo}: no actionable "${config.label}" issue`);
      continue;
    }

    log(`${repo}#${issue.number}: attempting with runner ${runner}`);
    const dir = await io.makeWorkdir({ repo, issue: issue.number });
    try {
      await io.clone({ repo, dir });
      const exitCode = await io.runEngine({
        dir,
        issue: issue.number,
        runner,
        env: buildRunEnv(env, { token: config.token, model: config.model, effort: config.effort }),
      });
      return {
        status: exitCode === 0 ? "worked" : "failed",
        repo,
        issue: issue.number,
        runner,
        exitCode,
        skipped,
      };
    } finally {
      // Ephemeral by construction — the clone dies with the run, success or not.
      await io.cleanup(dir);
    }
  }

  return { status: "empty" };
}
