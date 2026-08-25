// project-identity-migration — merge a `remote:<slug>` project into its
// `github:<id>` identity, everywhere the daemon keyed state by project id.
//
// The identity coin-flip (an unauthenticated per-bind GitHub read) left one
// repository standing as TWO projects: two full clones, two control rows —
// with drain intent recorded on one spelling invisible to a connection bound
// under the other — and two memory roots. The durable identity cache stops NEW
// twins from forming; this migration repairs the history, one alias pair at a
// time, idempotently, under the daemon's single-writer ownership of the files
// it touches.
//
// Merge rules, decided with the maintainer:
// - **Control rows**: the `github:` row wins field-wise; drain intent merges
//   restrictively (a drain issued against either identity must survive, so
//   `draining` on either side is `draining` on the merged row); revision takes
//   the max so no consumer sees it move backwards.
// - **Workspaces**: never keep both clones. The `github:` workspace wins; a
//   lone `remote:` workspace is renamed onto the canonical name.
// - **Memory roots**: merging two live stores is not mechanical, so the
//   `github:` root wins and a coexisting `remote:` root is set aside as
//   `<name>.superseded` — documented, recoverable, never silently dropped.
// - **Session journal**: rows re-keyed to the canonical id, so retake and
//   recovery stop splitting on the spelling.
import { rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ProjectControlState } from "./project-control.js";
import { projectDirectoryName } from "./project-workspace.js";

export interface ProjectIdentityAlias {
  readonly slug: string;
  readonly githubId: string;
  readonly fullName: string;
}

export interface MigrateProjectIdentityDeps {
  readonly projectWorkspaceRoot: string;
  /** The `~/.red/memory` parent; absent skips the memory step. */
  readonly memoryRoot?: string;
  /**
   * The LIVE control map and its persist path, handed in by the one process
   * that owns them. The control plane holds this map in memory and persists it
   * whole, so a migration that re-keyed only the file would be silently undone
   * by the next control write.
   */
  readonly projectControls: Map<string, ProjectControlState>;
  readonly persistProjectControls: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>;
  /**
   * Re-keys journal sessions THROUGH the live journal instance. The migration
   * once rewrote the journal file directly; the durable journal object then
   * persisted its own in-memory snapshot over that rewrite, undoing it on
   * every append — the same single-writer rule the control map already
   * follows, learned twice.
   */
  readonly rekeySessions: (fromProjectId: string, toProjectId: string, projectLabel: string) => Promise<number>;
}

export interface ProjectIdentityMigrationReport {
  readonly from: string;
  readonly to: string;
  /** What happened, one operator-readable sentence per touched surface. */
  readonly actions: readonly string[];
}

/** Merge one alias pair everywhere. Idempotent; a clean pass reports nothing. */
export async function migrateProjectIdentity(
  alias: ProjectIdentityAlias,
  deps: MigrateProjectIdentityDeps,
): Promise<ProjectIdentityMigrationReport> {
  const from = `remote:${alias.slug}`;
  const to = `github:${alias.githubId}`;
  const actions: string[] = [];

  // 1. Control rows: re-key or merge, so drain intent recorded under either
  //    spelling drives the one surviving project. The LIVE map is mutated —
  //    the control plane persists that map whole, so a file-only rewrite
  //    would be silently undone by its next write.
  const controls = deps.projectControls;
  const held = controls.get(from);
  if (held != null) {
    const canonical = controls.get(to);
    const merged: ProjectControlState = canonical == null ? held : {
      ...canonical,
      drainIntent: held.drainIntent === "draining" || canonical.drainIntent === "draining"
        ? "draining"
        : canonical.drainIntent,
      revision: Math.max(held.revision, canonical.revision),
      ...((canonical.target ?? held.target) == null ? {} : { target: (canonical.target ?? held.target) as number }),
      ...((canonical.runner ?? held.runner) == null ? {} : { runner: (canonical.runner ?? held.runner) as string }),
    };
    controls.delete(from);
    controls.set(to, merged);
    await deps.persistProjectControls(controls);
    actions.push(canonical == null
      ? `re-keyed the ${from} control row to ${to}`
      : `merged the ${from} control row into ${to} (drain intent ${merged.drainIntent})`);
  }

  // 2. Workspaces: one clone per repository.
  const fromDir = join(deps.projectWorkspaceRoot, projectDirectoryName(from));
  const toDir = join(deps.projectWorkspaceRoot, projectDirectoryName(to));
  if (await exists(fromDir)) {
    if (await exists(toDir)) {
      await rm(fromDir, { recursive: true, force: true });
      actions.push(`removed the duplicate ${from} workspace clone (the ${to} clone stands)`);
    } else {
      await rename(fromDir, toDir);
      actions.push(`renamed the ${from} workspace onto its canonical ${to} name`);
    }
  }

  // 3. Memory roots: the canonical root wins; a displaced one is set aside.
  if (deps.memoryRoot != null) {
    const fromMemory = join(deps.memoryRoot, projectDirectoryName(from));
    const toMemory = join(deps.memoryRoot, projectDirectoryName(to));
    if (await exists(fromMemory)) {
      if (await exists(toMemory)) {
        await rename(fromMemory, `${fromMemory}.superseded`);
        actions.push(`set the ${from} memory root aside as .superseded (the ${to} root stands)`);
      } else {
        await rename(fromMemory, toMemory);
        actions.push(`renamed the ${from} memory root onto its canonical ${to} name`);
      }
    }
  }

  // 4. Session journal: rows follow the surviving identity, re-keyed through
  //    the one live journal object so its next append cannot undo the move.
  const rekeyed = await deps.rekeySessions(from, to, alias.fullName);
  if (rekeyed > 0) actions.push(`re-keyed ${rekeyed} journal session(s) from ${from} to ${to}`);

  return { from, to, actions };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The `~/.red/memory` parent derived from the daemon's own workspace root. */
export function memoryRootBesideWorkspaces(projectWorkspaceRoot: string): string {
  return join(dirname(dirname(projectWorkspaceRoot)), "memory");
}
