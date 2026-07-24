// fleet-create-reap — reap orphaned workers on fleet_create failure.
//
// When fleet_create detects a fast-death (supervisor pid file never appeared),
// the supervisor may have dispatched one or more workers before dying. Those
// workers are left orphaned — no supervisor to respawn/land them. This module
// kills their process groups and concedes their GitHub claims so a failed create
// leaves zero residue (no live worker process, no held claim).

import { readFleetState } from '../runtime/wire.js';
import { readAllWorkerStates } from './worker-state-reader.js';
import { signalTree } from '../runtime/kill-tree.js';

/**
 * Kill any worker processes the dying supervisor dispatched (via slot_pids in
 * the fleet state file), and concede their GitHub claims.
 *
 * Called by fleet_create on failure — AFTER the profile rollback — as a
 * best-effort cleanup. Each step swallows its own errors so a failed reap
 * never shadows the real spawn error.
 */
export async function reapOrphanedFleetWorkers(
  fleetStatePath: string,
  tmpDir: string,
  concedeClaim: (issue: number, worker: { id: string; runner: string }) => Promise<void>,
): Promise<void> {
  const state = await readFleetState(fleetStatePath).catch(() => null);
  const slotPids = state?.slotPids;
  if (!slotPids?.length) return;

  const pidSet = new Set<number>();
  for (const { pid } of slotPids) {
    if (pid > 0) pidSet.add(pid);
  }
  if (pidSet.size === 0) return;

  for (const pid of pidSet) {
    signalTree(pid, 'SIGKILL');
  }

  const workers = await readAllWorkerStates(tmpDir).catch(() => []);
  const conceded = new Set<number>();
  for (const record of workers) {
    const { pid, worker_id, runner, current } = record.state;
    if (!pidSet.has(pid)) continue;
    const rawIssue = current.number;
    if (!rawIssue) continue;
    const issue =
      typeof rawIssue === 'number' ? rawIssue : parseInt(String(rawIssue), 10);
    if (!Number.isFinite(issue) || issue <= 0 || conceded.has(issue)) continue;
    conceded.add(issue);
    await concedeClaim(issue, { id: worker_id, runner }).catch(() => undefined);
  }
}
