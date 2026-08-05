import type { ChangesetQueue, QueuedChange } from "./changeset-queue.js";
import {
  computeNextVersion,
  type ReleaseClock,
  type VersionScheme,
} from "./version-core.js";

interface ReleaseStatusInput {
  readonly queue: ChangesetQueue;
  readonly currentVersion: string;
  readonly scheme: VersionScheme;
  readonly clock: ReleaseClock;
}

export interface NoReleaseStatus {
  readonly outcome: "no-release";
  readonly currentVersion: string;
  readonly changes: readonly [];
}

export interface PendingReleaseStatus {
  readonly outcome: "pending-release";
  readonly currentVersion: string;
  readonly nextVersion: string;
  readonly changes: readonly QueuedChange[];
}

export type ReleaseStatus = NoReleaseStatus | PendingReleaseStatus;

/** Turn queue data into a first-class release/no-release result through the pure version core. */
export function computeReleaseStatus(input: ReleaseStatusInput): ReleaseStatus {
  if (input.queue.changes.length === 0) {
    return { outcome: "no-release", currentVersion: input.currentVersion, changes: [] };
  }
  return {
    outcome: "pending-release",
    currentVersion: input.currentVersion,
    nextVersion: computeNextVersion({
      currentVersion: input.currentVersion,
      pending: input.queue.pending,
      scheme: input.scheme,
      clock: input.clock,
    }),
    changes: input.queue.changes,
  };
}

export function renderReleaseStatus(status: ReleaseStatus): string {
  const lines = ["Release status", `Current version: ${status.currentVersion}`];
  if (status.outcome === "no-release") {
    lines.push("Outcome: no release", "Pending changes: 0");
    return `${lines.join("\n")}\n`;
  }

  lines.push(
    `Next version: ${status.nextVersion}`,
    `Pending changes: ${status.changes.length}`,
    "Changes:",
  );
  for (const change of status.changes) {
    const packages = change.releases.map((release) => release.packageName).join(", ");
    lines.push(`  - ${change.impact}: ${change.file} — ${change.summary} [${packages}]`);
  }
  return `${lines.join("\n")}\n`;
}
