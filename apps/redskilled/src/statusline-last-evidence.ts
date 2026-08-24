// statusline-last-evidence — what the DEAD daemon left behind, read directly.
//
// While the daemon is down every surface degrades to a generic "unreachable",
// yet the evidence for WHY sits on disk the whole time: the death lane the
// daemon's own recorder writes (`~/.red/redskilled/state/deaths/`). That lane
// was only ever read by the reaper and by the daemon that replaces the dead
// one — so the one reader who needed it (the operator staring at an
// unreachable statusline) never saw it. This module is the absence arm's
// second line: the newest daemon death, dated, with the record's own facts.
//
// No freshness cutoff, deliberately: a daemon down for three days IS explained
// by a death three days old, and the age in the sentence is the honesty.
import { join } from "node:path";

import { readProcessDeathLane, type ProcessDeathRecord } from "@reddb-io/shared/death-record.js";
import { deathLaneFileIn } from "@reddb-io/shared/red-paths.js";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";

/** The daemon's own death lane, under the host-scoped home. */
export function daemonDeathLanePath(homeDir: string): string {
  return deathLaneFileIn(join(redskilledHomeDir(homeDir), "state"));
}

/**
 * One operator-readable line naming the newest daemon death, or `null`.
 *
 * Never throws: an unreadable lane answers nothing, exactly like an empty one
 * — this runs on the absence path, where everything else already failed.
 */
export function readLastDaemonDeathHeadline(lanePath: string, nowMs: number): string | null {
  let records: ProcessDeathRecord[];
  try {
    records = readProcessDeathLane(lanePath);
  } catch {
    return null;
  }
  const daemon = records
    .filter((record) => record.kind === "daemon")
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts))[0];
  if (daemon == null) return null;
  const diedAt = Date.parse(daemon.ts);
  if (!Number.isFinite(diedAt)) return null;
  const how = daemon.signal != null
    ? `by ${daemon.signal}`
    : daemon.exit_code != null
      ? `exit ${daemon.exit_code}`
      : daemon.exit_path;
  const detail = daemon.detail == null || daemon.detail.trim() === ""
    ? ""
    : ` — ${daemon.detail.replace(/\s+/g, " ").trim().slice(0, 160)}`;
  return `last daemon death ${formatEvidenceAge(Math.max(0, nowMs - diedAt))} ago ` +
    `(${how}, phase ${daemon.last_phase})${detail}`;
}

function formatEvidenceAge(ageMs: number): string {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
