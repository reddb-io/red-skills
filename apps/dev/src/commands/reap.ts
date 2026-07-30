import {
  branchesToReap,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
} from "../core/branch-cleanup.js";
import { planBranchReclaim } from "../core/branch-reclaim.js";
import { collectReapInputs, resolveRepoContext } from "../runtime/wire.js";

/**
 * `reap` — native branch reaper. Lists remote/local afk/* refs, classifies
 * each via the pure branch-cleanup planners against the pre-resolved gh
 * issue-state cache, prints the count lines, and deletes per plan. No bash.
 *
 * The LOCAL pass runs through the branch reclaim (#2866), which decides on the
 * landed fact and refuses infrastructure refs by name, and it prints what it
 * spared as well as what it deleted — an operator reading this must be able to
 * see that `red-trunk` was kept on purpose rather than missed by accident.
 */
export async function reapCommand(
  _args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const ctx = await resolveRepoContext(cwd);
  const inputs = await collectReapInputs(ctx);
  const nowS = Math.floor(Date.now() / 1000);

  const remoteLivePlan = planLiveBranchCleanup(inputs.remoteLiveRefs, inputs.lookup, nowS);
  const remoteLiveReap = branchesToReap(remoteLivePlan);

  const issueClosed = new Set(
    branchesToReap(planLocalBranchCleanup(inputs.localLiveRefs, inputs.lookup, nowS))
      .map((d) => d.branch),
  );
  const landed = new Set(inputs.landedLocalBranches);
  const localPlan = planBranchReclaim(
    inputs.localLiveRefs.map((ref) => ({
      branch: ref.branch,
      landed: landed.has(ref.branch),
      issueClosed: issueClosed.has(ref.branch),
    })),
    { trunk: inputs.trunk },
  );

  stdout.write(`reap: afk/* remote live: ${inputs.remoteLiveRefs.length} found, ${remoteLiveReap.length} to reap\n`);
  stdout.write(
    `reap: afk/* local live: ${localPlan.totals.considered} found, ${localPlan.totals.reclaim} to reap, ${localPlan.totals.spare} spared\n`,
  );

  for (const d of remoteLiveReap) {
    await inputs.deleteRemote(d.branch);
    stdout.write(`reaped (remote live): ${d.branch}\n`);
  }
  for (const d of localPlan.reclaim) {
    await inputs.deleteLocal(d.branch);
    stdout.write(`reaped (local live): ${d.branch} — ${d.reason}\n`);
  }
  for (const d of localPlan.spare) {
    stdout.write(`spared (local live): ${d.branch} — ${d.reason}\n`);
  }

  return 0;
}
