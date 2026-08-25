// The identity coin-flip left one repository standing as TWO projects: two
// full clones, two control rows (drain intent on one spelling invisible to
// the other), two memory roots, and journal sessions split across both. The
// durable cache stops new twins; this migration repairs the history — and
// these tests pin its merge rules and its idempotence.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  memoryRootBesideWorkspaces,
  migrateProjectIdentity,
} from "../src/project-identity-migration.js";
import { projectDirectoryName } from "../src/project-workspace.js";
import type { ProjectControlState } from "../src/project-control.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ALIAS = { slug: "reddb-io/red-skills", githubId: "1240684599", fullName: "reddb-io/red-skills" };
const FROM = "remote:reddb-io/red-skills";
const TO = "github:1240684599";

async function host() {
  const root = await mkdtemp(join(tmpdir(), "redskilled-identity-migration-"));
  roots.push(root);
  const projectWorkspaceRoot = join(root, ".red", "redskilled", "projects");
  await mkdir(projectWorkspaceRoot, { recursive: true });
  const persisted: unknown[] = [];
  const rekeys: { from: string; to: string; label: string }[] = [];
  const projectControls = new Map<string, ProjectControlState>();
  return {
    root,
    persisted,
    rekeys,
    deps: {
      projectWorkspaceRoot,
      memoryRoot: memoryRootBesideWorkspaces(projectWorkspaceRoot),
      projectControls,
      persistProjectControls: async (projects: ReadonlyMap<string, ProjectControlState>) => {
        persisted.push(new Map(projects));
      },
      // Journal re-keying goes THROUGH the live journal instance (the file
      // rewrite was silently undone by the journal's own next append); the
      // migration only reports what the instance answered.
      // The default host holds no journal sessions; the re-key test overrides.
      rekeySessions: async (from: string, to: string, label: string) => {
        rekeys.push({ from, to, label });
        return 0;
      },
    },
  };
}

const state = (overrides: Partial<ProjectControlState>): ProjectControlState => ({
  drainIntent: "stopped",
  revision: 1,
  updates: [],
  ...overrides,
});

describe("migrating a remote: project onto its github: identity", () => {
  it("re-keys a lone remote control row and renames its workspace and memory root", async () => {
    const { deps } = await host();
    deps.projectControls.set(FROM, state({ drainIntent: "draining", revision: 8, target: 1 }));
    const fromWorkspace = join(deps.projectWorkspaceRoot, projectDirectoryName(FROM));
    await mkdir(join(fromWorkspace, "workspace"), { recursive: true });
    const fromMemory = join(deps.memoryRoot, projectDirectoryName(FROM));
    await mkdir(fromMemory, { recursive: true });

    const report = await migrateProjectIdentity(ALIAS, deps);

    expect(deps.projectControls.has(FROM)).toBe(false);
    expect(deps.projectControls.get(TO)).toMatchObject({ drainIntent: "draining", target: 1 });
    expect(existsSync(join(deps.projectWorkspaceRoot, projectDirectoryName(TO), "workspace"))).toBe(true);
    expect(existsSync(fromWorkspace)).toBe(false);
    expect(existsSync(join(deps.memoryRoot, projectDirectoryName(TO)))).toBe(true);
    expect(report.actions).toHaveLength(3);
  });

  it("merges drain intent restrictively when both rows exist, and drops the duplicate clone", async () => {
    const { deps } = await host();
    deps.projectControls.set(FROM, state({ drainIntent: "draining", revision: 23, runner: "codex" }));
    deps.projectControls.set(TO, state({ drainIntent: "stopped", revision: 8, target: 2 }));
    await mkdir(join(deps.projectWorkspaceRoot, projectDirectoryName(FROM), "workspace"), { recursive: true });
    await mkdir(join(deps.projectWorkspaceRoot, projectDirectoryName(TO), "workspace"), { recursive: true });
    const fromMemory = join(deps.memoryRoot, projectDirectoryName(FROM));
    await mkdir(fromMemory, { recursive: true });
    await mkdir(join(deps.memoryRoot, projectDirectoryName(TO)), { recursive: true });

    await migrateProjectIdentity(ALIAS, deps);

    // A drain issued against either identity survives the merge.
    expect(deps.projectControls.get(TO)).toMatchObject({
      drainIntent: "draining",
      revision: 23,
      target: 2,
      runner: "codex",
    });
    expect(existsSync(join(deps.projectWorkspaceRoot, projectDirectoryName(FROM)))).toBe(false);
    // Two live memory stores never merge mechanically: the displaced one is
    // set aside, recoverable, never silently dropped.
    expect(existsSync(`${fromMemory}.superseded`)).toBe(true);
  });

  it("re-keys journal sessions through the live journal instance, never the file", async () => {
    const { deps, rekeys } = await host();

    const report = await migrateProjectIdentity(ALIAS, {
      ...deps,
      rekeySessions: async (from, to, label) => {
        rekeys.push({ from, to, label });
        return 1;
      },
    });

    expect(rekeys).toEqual([{ from: FROM, to: TO, label: ALIAS.fullName }]);
    expect(report.actions).toEqual([expect.stringContaining("re-keyed 1 journal session")]);
  });

  it("is idempotent — a second pass finds nothing to do", async () => {
    const { deps, persisted } = await host();
    deps.projectControls.set(FROM, state({ drainIntent: "draining" }));
    await mkdir(join(deps.projectWorkspaceRoot, projectDirectoryName(FROM), "workspace"), { recursive: true });

    await migrateProjectIdentity(ALIAS, deps);
    const persistsAfterFirst = persisted.length;
    const second = await migrateProjectIdentity(ALIAS, deps);

    expect(second.actions).toEqual([]);
    expect(persisted.length).toBe(persistsAfterFirst);
  });
});
