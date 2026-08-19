import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  HOOK_MARKER,
  installGitHooks,
  MANAGED_HOOKS,
  renderHookScript,
  uninstallGitHooks,
} from "../src/vcs-hooks-install.js";

const dirs: string[] = [];

async function tempHooksDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-hooks-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("renderHookScript", () => {
  test("post-commit script no-ops fast and calls vcs refresh", () => {
    const s = renderHookScript("post-commit");
    expect(s).toContain(HOOK_MARKER);
    expect(s).toContain('grep -qE \'^[[:space:]]+memory:\' "$root/.red/config.yaml"');
    expect(s).toContain('[ -f "$root/.red/memory/config.json" ] || exit 0');
    expect(s).toContain("vcs refresh --event post-commit");
    // No bootstrap path embedded → no embedded-bootstrap branch.
    expect(s).not.toContain("set -- node");
  });

  test("post-checkout script captures git's prev/new/flag args", () => {
    const s = renderHookScript("post-checkout", "/abs/scripts/bootstrap.mjs");
    expect(s).toContain('prev="$1"; new_head="$2"; flag="$3"');
    expect(s).toContain("--prev \"$prev\" --new \"$new_head\" --flag \"$flag\"");
    // The embedded bootstrap path is single-quoted into a node invocation.
    expect(s).toContain("set -- node '/abs/scripts/bootstrap.mjs'");
  });
});

describe("installGitHooks (AC5 — opt-in installation)", () => {
  test("writes both managed hooks, executable and idempotent", async () => {
    const hooksDir = await tempHooksDir();
    const first = await installGitHooks({ hooksDir });
    expect(first.installed).toEqual([...MANAGED_HOOKS]);

    for (const hook of MANAGED_HOOKS) {
      const path = join(hooksDir, hook);
      expect(existsSync(path)).toBe(true);
      expect((await readFile(path, "utf8")).includes(HOOK_MARKER)).toBe(true);
      // Executable bit set for the owner.
      expect((await stat(path)).mode & 0o100).toBe(0o100);
    }

    // Re-installing over our own hooks just rewrites them, no skips.
    const second = await installGitHooks({ hooksDir });
    expect(second.installed).toEqual([...MANAGED_HOOKS]);
    expect(second.skipped).toEqual([]);
    expect(second.backedUp).toEqual([]);
  });

  test("leaves a foreign hook untouched without --force", async () => {
    const hooksDir = await tempHooksDir();
    const foreign = join(hooksDir, "post-commit");
    await writeFile(foreign, "#!/bin/sh\necho mine\n", "utf8");

    const result = await installGitHooks({ hooksDir });
    expect(result.installed).toEqual(["post-checkout"]);
    expect(result.skipped.map((s) => s.hook)).toEqual(["post-commit"]);
    // Foreign content preserved.
    expect(await readFile(foreign, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  test("--force backs up a foreign hook then replaces it", async () => {
    const hooksDir = await tempHooksDir();
    const foreign = join(hooksDir, "post-commit");
    await writeFile(foreign, "#!/bin/sh\necho mine\n", "utf8");

    const result = await installGitHooks({ hooksDir, force: true });
    expect(result.installed).toContain("post-commit");
    expect(result.backedUp).toEqual([`${foreign}.pre-memory.bak`]);
    expect(await readFile(`${foreign}.pre-memory.bak`, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect((await readFile(foreign, "utf8")).includes(HOOK_MARKER)).toBe(true);
  });
});

describe("uninstallGitHooks", () => {
  test("removes managed hooks and restores backups", async () => {
    const hooksDir = await tempHooksDir();
    const foreign = join(hooksDir, "post-commit");
    await writeFile(foreign, "#!/bin/sh\necho mine\n", "utf8");
    await installGitHooks({ hooksDir, force: true }); // backs up foreign post-commit

    const result = await uninstallGitHooks(hooksDir);
    expect(result.removed.sort()).toEqual([...MANAGED_HOOKS].sort());
    expect(result.restored).toEqual([foreign]);
    // The original foreign hook is back in place.
    expect(await readFile(foreign, "utf8")).toBe("#!/bin/sh\necho mine\n");
    // The other managed hook is gone.
    expect(existsSync(join(hooksDir, "post-checkout"))).toBe(false);
  });

  test("leaves a foreign hook of the same name untouched", async () => {
    const hooksDir = await tempHooksDir();
    const foreign = join(hooksDir, "post-commit");
    await writeFile(foreign, "#!/bin/sh\necho mine\n", "utf8");
    await chmod(foreign, 0o755);

    const result = await uninstallGitHooks(hooksDir);
    expect(result.removed).toEqual([]);
    expect(result.skipped.map((s) => s.hook)).toEqual(["post-commit"]);
    expect(existsSync(foreign)).toBe(true);
  });
});
