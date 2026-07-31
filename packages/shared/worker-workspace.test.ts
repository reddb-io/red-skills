import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_PRESET,
  MEMORY_BACKED_FILESYSTEMS,
  WORKSPACE_PRESETS,
  WORKSPACE_TARGET_CONFIG_KEY,
  WorkspaceConfigError,
  WorkspaceRefusalError,
  assertWorkspaceTargetUsable,
  declaredWorkspaceTargetInConfig,
  isMemoryBackedFilesystem,
  isUnderAutomaticCleanup,
  mountedFilesystemType,
  parseTmpfilesCleanupPaths,
  parseWorkspaceTarget,
  refuseWorkspaceTarget,
  resolveWorkspaceLayout,
  workerWorkspaceDir,
  workerWorktreeDir,
  workspaceReadsRedskilledHome,
  type WorkspaceLayoutInput,
} from "./worker-workspace.js";

/**
 * Table-driven and filesystem-free by contract, exactly like the identity suite:
 * a layout is proven over literal inputs, and a refusal is proven over literal
 * FACTS about a target rather than over whatever `/tmp` happens to be on the
 * machine running the suite.
 */

const BASE: Omit<WorkspaceLayoutInput, "target"> = {
  repoRoot: "/home/dev/code/red-skills",
  slug: "reddb-io--red-skills-1a2b3c4d",
  homeDir: "/home/dev",
};

describe("parseWorkspaceTarget — a closed set, not a free-for-all", () => {
  it("defaults to the local preset when nothing is declared", () => {
    for (const value of [undefined, "", "   "]) {
      expect(parseWorkspaceTarget(value)).toEqual({ kind: "preset", preset: DEFAULT_WORKSPACE_PRESET });
    }
    expect(DEFAULT_WORKSPACE_PRESET).toBe("local");
  });

  it("accepts every documented preset name, case- and space-insensitively", () => {
    for (const preset of WORKSPACE_PRESETS) {
      expect(parseWorkspaceTarget(` ${preset.toUpperCase()} `)).toEqual({ kind: "preset", preset });
    }
  });

  it("treats an absolute path as the parent directory of Workers", () => {
    expect(parseWorkspaceTarget("/mnt/fast/redskilled")).toEqual({
      kind: "custom",
      parentDir: "/mnt/fast/redskilled",
    });
  });

  it("treats a home-relative path as a custom parent directory", () => {
    expect(parseWorkspaceTarget("~/scratch/workers")).toEqual({
      kind: "custom",
      parentDir: "~/scratch/workers",
    });
  });

  it("refuses an unknown preset name as a config error rather than falling back", () => {
    for (const value of ["locl", "global", "ram", "workers"]) {
      let thrown: unknown;
      try {
        parseWorkspaceTarget(value);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkspaceConfigError);
      expect((thrown as WorkspaceConfigError).message).toContain(value);
      expect((thrown as WorkspaceConfigError).message).toContain(WORKSPACE_TARGET_CONFIG_KEY);
      expect((thrown as WorkspaceConfigError).message).toContain("local, tmp, host");
    }
  });

  it("refuses a relative path — a Worker parent is never resolved against a cwd", () => {
    expect(() => parseWorkspaceTarget("./workers")).toThrow(WorkspaceConfigError);
    expect(() => parseWorkspaceTarget("../elsewhere")).toThrow(WorkspaceConfigError);
  });
});

describe("declaredWorkspaceTargetInConfig", () => {
  it("reads the declared target out of config text", () => {
    const text = `plugins:\n  dev:\n    enabled: true\n    workspace:\n      target: host\n`;
    expect(declaredWorkspaceTargetInConfig(text)).toBe("host");
  });

  it("is undefined when the key is absent or blank", () => {
    expect(declaredWorkspaceTargetInConfig("plugins:\n  dev:\n    enabled: true\n")).toBeUndefined();
    expect(declaredWorkspaceTargetInConfig(`plugins:\n  dev:\n    workspace:\n      target: ""\n`)).toBeUndefined();
  });
});

describe("resolveWorkspaceLayout — each preset resolves to its documented layout", () => {
  const cases: { readonly label: string; readonly input: WorkspaceLayoutInput; readonly workersDir: string; readonly lane: string; readonly segmented: boolean }[] = [
    {
      label: "local stays flat inside the repository tmp tier, with no segmentation",
      input: { ...BASE, target: { kind: "preset", preset: "local" } },
      workersDir: "/home/dev/code/red-skills/.red/tmp/workers",
      lane: "local",
      segmented: false,
    },
    {
      label: "tmp segments by repository under the deterministic slug",
      input: { ...BASE, target: { kind: "preset", preset: "tmp" } },
      workersDir: "/tmp/.redskilled/repositories/reddb-io--red-skills-1a2b3c4d/workers",
      lane: "tmp",
      segmented: true,
    },
    {
      label: "host segments the same way under the operator home",
      input: { ...BASE, target: { kind: "preset", preset: "host" } },
      workersDir: "/home/dev/.red/redskilled/repositories/reddb-io--red-skills-1a2b3c4d/workers",
      lane: "host",
      segmented: true,
    },
    {
      label: "a custom value IS the parent of Workers, verbatim and unsegmented",
      input: { ...BASE, target: { kind: "custom", parentDir: "/mnt/fast/redskilled" } },
      workersDir: "/mnt/fast/redskilled",
      lane: "custom",
      segmented: false,
    },
    {
      label: "a custom `~` value expands against the operator home",
      input: { ...BASE, target: { kind: "custom", parentDir: "~/scratch/workers" } },
      workersDir: "/home/dev/scratch/workers",
      lane: "custom",
      segmented: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      const layout = resolveWorkspaceLayout(testCase.input);
      expect(layout.workersDir).toBe(testCase.workersDir);
      expect(layout.lane).toBe(testCase.lane);
      expect(layout.segmented).toBe(testCase.segmented);
    });
  }

  it("honours an overridden tmp root so the preset is testable off a real /tmp", () => {
    const layout = resolveWorkspaceLayout({ ...BASE, target: { kind: "preset", preset: "tmp" }, tmpRoot: "/scratch" });
    expect(layout.workersDir).toBe("/scratch/.redskilled/repositories/reddb-io--red-skills-1a2b3c4d/workers");
  });

  it("keeps the flat Worker layout with the worktree as its direct child, in every lane", () => {
    for (const preset of WORKSPACE_PRESETS) {
      const layout = resolveWorkspaceLayout({ ...BASE, target: { kind: "preset", preset } });
      expect(workerWorkspaceDir(layout, "w7O3D", "2779")).toBe(`${layout.workersDir}/w7O3D/2779`);
      expect(workerWorktreeDir(layout, "w7O3D", "2779")).toBe(`${layout.workersDir}/w7O3D/2779/worktree`);
    }
  });

  it("refuses a Worker id or ticket that would escape its lane", () => {
    const layout = resolveWorkspaceLayout({ ...BASE, target: { kind: "preset", preset: "local" } });
    expect(() => workerWorkspaceDir(layout, "../escape", "2779")).toThrow(WorkspaceConfigError);
    expect(() => workerWorkspaceDir(layout, "w7O3D", "../2779")).toThrow(WorkspaceConfigError);
  });

  it("requires a slug for a segmented preset and never for local", () => {
    expect(() => resolveWorkspaceLayout({ ...BASE, slug: "", target: { kind: "preset", preset: "host" } })).toThrow(
      WorkspaceConfigError,
    );
    expect(resolveWorkspaceLayout({ ...BASE, slug: "", target: { kind: "preset", preset: "local" } }).workersDir).toBe(
      "/home/dev/code/red-skills/.red/tmp/workers",
    );
  });
});

describe("workspaceReadsRedskilledHome — who actually needs the daemon's home", () => {
  // The home is a lane root, never a daemon precondition (#2958): the daemon
  // resolves it nowhere, so only a target rooted inside it needs it to exist.
  it("is true only for the host preset and a custom parent under the home", () => {
    expect(workspaceReadsRedskilledHome({ kind: "preset", preset: "host" }, "/home/dev")).toBe(true);
    expect(workspaceReadsRedskilledHome({ kind: "custom", parentDir: "~/.red/redskilled/repositories" }, "/home/dev")).toBe(true);
    expect(workspaceReadsRedskilledHome({ kind: "custom", parentDir: "/home/dev/.red/redskilled" }, "/home/dev")).toBe(true);
  });

  it("is false for every lane that lives elsewhere", () => {
    expect(workspaceReadsRedskilledHome({ kind: "preset", preset: "local" }, "/home/dev")).toBe(false);
    expect(workspaceReadsRedskilledHome({ kind: "preset", preset: "tmp" }, "/home/dev")).toBe(false);
    expect(workspaceReadsRedskilledHome({ kind: "custom", parentDir: "/mnt/fast/workers" }, "/home/dev")).toBe(false);
    // Boundary-aware, so a sibling that merely shares a prefix is not the home.
    expect(workspaceReadsRedskilledHome({ kind: "custom", parentDir: "/home/dev/.red/redskilled-old" }, "/home/dev")).toBe(false);
  });
});

describe("refuseWorkspaceTarget — the refusal is load-bearing", () => {
  const layout = resolveWorkspaceLayout({ ...BASE, target: { kind: "preset", preset: "tmp" } });

  it("refuses a memory-backed target outright, naming the budget it would consume", () => {
    const refusal = refuseWorkspaceTarget(layout, { path: "/tmp", filesystemType: "tmpfs" });
    expect(refusal?.reason).toBe("memory-backed-filesystem");
    expect(refusal?.message).toContain("tmpfs");
    expect(refusal?.message).toContain("/tmp");
  });

  it("refuses every memory-backed filesystem type it knows, however spelled", () => {
    for (const fsType of MEMORY_BACKED_FILESYSTEMS) {
      expect(isMemoryBackedFilesystem(fsType.toUpperCase())).toBe(true);
      expect(refuseWorkspaceTarget(layout, { path: "/tmp", filesystemType: fsType })?.reason).toBe(
        "memory-backed-filesystem",
      );
    }
    expect(isMemoryBackedFilesystem("ext4")).toBe(false);
    expect(isMemoryBackedFilesystem(undefined)).toBe(false);
  });

  it("refuses a target subject to automatic cleanup — it would delete a live Worker's worktree", () => {
    const refusal = refuseWorkspaceTarget(layout, { path: "/tmp", filesystemType: "ext4", autoCleaned: true });
    expect(refusal?.reason).toBe("automatic-cleanup");
    expect(refusal?.message).toContain("/tmp");
  });

  it("reports the memory-backed reason first when a target is both", () => {
    expect(refuseWorkspaceTarget(layout, { path: "/tmp", filesystemType: "tmpfs", autoCleaned: true })?.reason).toBe(
      "memory-backed-filesystem",
    );
  });

  it("accepts a durable, unswept target", () => {
    expect(refuseWorkspaceTarget(layout, { path: "/tmp", filesystemType: "ext4" })).toBeUndefined();
    expect(refuseWorkspaceTarget(layout, { path: "/tmp" })).toBeUndefined();
  });

  it("throws rather than warns when asserted", () => {
    let thrown: unknown;
    try {
      assertWorkspaceTargetUsable(layout, { path: "/tmp", filesystemType: "tmpfs" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceRefusalError);
    expect((thrown as WorkspaceRefusalError).refusal.reason).toBe("memory-backed-filesystem");
    expect(() => assertWorkspaceTargetUsable(layout, { path: "/tmp", filesystemType: "ext4" })).not.toThrow();
  });
});

describe("target facts — parsed from what the host actually declares", () => {
  const MOUNTS = [
    "/dev/sda2 / ext4 rw,relatime 0 0",
    "tmpfs /tmp tmpfs rw,nosuid,nodev 0 0",
    "/dev/sdb1 /mnt/fast xfs rw,relatime 0 0",
    "none /run/user/1000 tmpfs rw 0 0",
  ].join("\n");

  it("reads the filesystem type from the longest matching mount point", () => {
    expect(mountedFilesystemType(MOUNTS, "/tmp/.redskilled/repositories/x/workers")).toBe("tmpfs");
    expect(mountedFilesystemType(MOUNTS, "/mnt/fast/redskilled")).toBe("xfs");
    expect(mountedFilesystemType(MOUNTS, "/home/dev/code")).toBe("ext4");
    expect(mountedFilesystemType(MOUNTS, "/mnt/fastidious")).toBe("ext4");
  });

  it("unescapes octal-escaped mount points, which is how a space is spelled", () => {
    expect(mountedFilesystemType("/dev/sdc1 /mnt/my\\040disk ext4 rw 0 0", "/mnt/my disk/workers")).toBe("ext4");
  });

  it("is undefined when nothing matches at all", () => {
    expect(mountedFilesystemType("", "/tmp")).toBeUndefined();
  });

  it("collects the age-swept directories a tmpfiles.d config declares", () => {
    const config = [
      "# Type Path        Mode User Group Age Argument",
      "d /tmp        1777 root root 10d",
      "D /var/tmp    1777 root root 30d",
      "d /var/lib/x  0755 root root -",
      "x /tmp/.X11-unix",
      "L /run/link - - - - /target",
    ].join("\n");
    expect([...parseTmpfilesCleanupPaths([config])].sort()).toEqual(["/tmp", "/var/tmp"]);
  });

  it("treats a path under a swept directory as subject to automatic cleanup", () => {
    const swept = parseTmpfilesCleanupPaths(["d /tmp 1777 root root 10d"]);
    expect(isUnderAutomaticCleanup("/tmp/.redskilled/repositories/x/workers", swept)).toBe(true);
    expect(isUnderAutomaticCleanup("/tmp", swept)).toBe(true);
    expect(isUnderAutomaticCleanup("/tmpfoo/workers", swept)).toBe(false);
    expect(isUnderAutomaticCleanup("/home/dev/code/red-skills/.red/tmp/workers", swept)).toBe(false);
  });
});
