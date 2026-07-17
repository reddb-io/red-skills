// core/red-path-migration.ts — the one-time, idempotent boot migration that
// relocates dev-owned DURABLE artifacts from their legacy homes to
// the ADR 0098 state-tier lanes (`.red/state/castle`, `.red/state/statusline`, the
// state-root branch lock). Pure: the planner only BUILDS paths from the shared
// path authority (`@reddb-io/shared/red-paths`); the runtime executor
// (runtime/red-path-migration.ts) does the fs moves.
//
// Contract (Spec #1681 / issue #1685):
//   - Move a legacy artifact to its canonical home ONLY when the canonical home
//     does not already hold that artifact. Never overwrite → never lose freshly
//     written state.
//   - When BOTH exist the state is AMBIGUOUS: leave the legacy copy in place and
//     NEVER delete it. A later reader still finds the canonical copy.
//   - When neither exists it is a no-op. A second boot (legacy already moved) is
//     therefore a pure no-op — the idempotency the acceptance criteria require.
//
// Worker/attempt lanes (workers/go-workers/scout-workers), the claim/wait
// registries, and the disposable scratch worktree lanes are NOT migrated: they
// are already collision-safe, swept, and keep their names.
import { join } from "node:path";
import {
  afkStateDir,
  legacyAfkStateDir,
  statuslineStateDir,
  tmpDir,
  stateDir,
} from "@reddb-io/shared/red-paths.js";

/** How a migration entry is materialised on disk. */
export type MigrationEntryKind = "file" | "dir";

/** One legacy → canonical relocation the boot migration performs. */
export interface DevPathMigrationEntry {
  /** Stable id for logging / tests (the legacy basename). */
  id: string;
  /** Legacy location under `.red/tmp`. */
  legacy: string;
  /** Canonical location under the state tier. */
  current: string;
  /** File vs directory move. */
  kind: MigrationEntryKind;
}

/**
 * The fixed set of dev-owned durable artifacts and their legacy → canonical
 * mapping, derived from `root` through the shared path authority. The rotated
 * supervisor launch logs (`afk-supervisor.log`, `afk-supervisor.log.jsonl`, and
 * any `afk-supervisor.log.N`) are collapsed to the single `afk-supervisor.log`
 * prefix entry; the executor expands it by globbing the legacy tmp dir.
 */
export function planDevDurablePathMigration(root: string): DevPathMigrationEntry[] {
  const tmp = tmpDir(root);
  const castleState = afkStateDir(root);
  const legacyAfkState = legacyAfkStateDir(root);
  const state = stateDir(root);
  const statusline = statuslineStateDir(root);
  const file = (name: string, dest: string): DevPathMigrationEntry => ({
    id: name,
    legacy: join(tmp, name),
    current: join(dest, name),
    kind: "file",
  });
  const renamedFile = (legacyName: string, dest: string, currentName: string): DevPathMigrationEntry => ({
    id: legacyName,
    legacy: join(tmp, legacyName),
    current: join(dest, currentName),
    kind: "file",
  });
  const fileFrom = (id: string, legacy: string, current: string): DevPathMigrationEntry => ({
    id,
    legacy,
    current,
    kind: "file",
  });
  const dirFrom = (id: string, legacy: string, current: string): DevPathMigrationEntry => ({
    id,
    legacy,
    current,
    kind: "dir",
  });
  const castleFile = (name: string): DevPathMigrationEntry => file(name, castleState);
  const legacyCastleFile = (name: string): DevPathMigrationEntry =>
    fileFrom(`state/afk/${name}`, join(legacyAfkState, name), join(castleState, name));
  return [
    castleFile("afk-supervisor.state.json"),
    castleFile("afk-supervisor.pid"),
    castleFile("afk-supervisor.stop"),
    castleFile("afk-supervisor.restarts.json"),
    castleFile("monitor-log-cursors.json"),
    { id: "runner-circuit", legacy: join(tmp, "runner-circuit"), current: join(castleState, "runner-circuit"), kind: "dir" },
    fileFrom("afk-history.toonl", join(state, "afk-history.toonl"), join(castleState, "history.toonl")),
    legacyCastleFile("afk-supervisor.state.json"),
    legacyCastleFile("afk-supervisor.pid"),
    legacyCastleFile("afk-supervisor.stop"),
    legacyCastleFile("afk-supervisor.restarts.json"),
    legacyCastleFile("monitor-log-cursors.json"),
    legacyCastleFile("afk-supervisor.log"),
    legacyCastleFile("afk-supervisor.log.toonl"),
    dirFrom("state/afk/runner-circuit", join(legacyAfkState, "runner-circuit"), join(castleState, "runner-circuit")),
    renamedFile("statusline-cache.json", statusline, "statusline-cache.toon"),
    renamedFile("statusline-repo-cache.json", statusline, "statusline-repo-cache.toon"),
    fileFrom("state/statusline-cache.json", join(statusline, "statusline-cache.json"), join(statusline, "statusline-cache.toon")),
    fileFrom(
      "state/statusline-repo-cache.json",
      join(statusline, "statusline-repo-cache.json"),
      join(statusline, "statusline-repo-cache.toon"),
    ),
    // NOTE: the branch lock is intentionally NOT migrated here. The branch-lock
    // skill's shell writer still owns `.red/tmp/branch-lock.yaml`; moving it out
    // from under that writer would silently break `/branch-lock`. The dev reader
    // (runtime/lock.ts) funnels through the authority and prefers whichever copy
    // exists, so it tracks the shell writer until that surface migrates too.
  ];
}

/**
 * The legacy tmp dir and the canonical state/castle dir, plus the filename prefix
 * for the rotated supervisor logs (`afk-supervisor.log`, `.log.jsonl`, `.log.N`).
 * The executor globs `legacyDir` for entries starting with `logPrefix` and moves
 * each to `currentDir` under the same idempotent rule.
 */
export function supervisorLogMigration(root: string): { legacyDir: string; currentDir: string; logPrefix: string } {
  return { legacyDir: tmpDir(root), currentDir: afkStateDir(root), logPrefix: "afk-supervisor.log" };
}

/** What the executor should do with one legacy/canonical pair. */
export type MigrationAction = "move" | "ambiguous" | "absent";

/**
 * The pure decision for one entry: MOVE when only the legacy copy exists,
 * AMBIGUOUS (leave both, delete nothing) when both exist, ABSENT (no-op) when
 * the legacy copy is gone — which is exactly the post-migration second-boot state.
 */
export function migrationActionFor(legacyExists: boolean, currentExists: boolean): MigrationAction {
  if (!legacyExists) return "absent";
  if (currentExists) return "ambiguous";
  return "move";
}
