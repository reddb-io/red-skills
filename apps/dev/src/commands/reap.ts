import {
  branchesToReap,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
} from "../core/branch-cleanup.js";
import { collectReapInputs, resolveRepoContext } from "../runtime/wire.js";

/**
 * `reap` — native branch reaper. Lists remote/local afk/* refs, classifies
 * each via the pure branch-cleanup planners against the pre-resolved gh
 * issue-state cache, prints the count lines, and deletes per plan. No bash.
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
  const localLivePlan = planLocalBranchCleanup(inputs.localLiveRefs, inputs.lookup, nowS);

  const remoteLiveReap = branchesToReap(remoteLivePlan);
  const localLiveReap = branchesToReap(localLivePlan);

  stdout.write(`reap: afk/* remote live: ${inputs.remoteLiveRefs.length} found, ${remoteLiveReap.length} to reap\n`);
  stdout.write(`reap: afk/* local live: ${inputs.localLiveRefs.length} found, ${localLiveReap.length} to reap\n`);

  for (const d of remoteLiveReap) {
    await inputs.deleteRemote(d.branch);
    stdout.write(`reaped (remote live): ${d.branch}\n`);
  }
  for (const d of localLiveReap) {
    await inputs.deleteLocal(d.branch);
    stdout.write(`reaped (local live): ${d.branch}\n`);
  }

  return 0;
}
