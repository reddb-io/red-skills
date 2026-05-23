import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

type HookCommand = {
  command: string;
};

type HookGroup = {
  hooks?: HookCommand[];
};

type HookManifest = {
  hooks: Record<string, HookGroup[]>;
};

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-hooks-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function loadManifest(path: string): Promise<HookManifest> {
  return JSON.parse(await readFile(path, "utf8")) as HookManifest;
}

function commands(manifest: HookManifest): string[] {
  return Object.values(manifest.hooks).flatMap((groups) =>
    groups.flatMap((group) => group.hooks?.map((hook) => hook.command) ?? []),
  );
}

describe("hook manifests", () => {
  test("Codex hooks fail open when dist/cli.js has not been built", async () => {
    const root = await tempRoot();
    const manifest = await loadManifest("hooks/codex.hooks.json");

    for (const command of commands(manifest)) {
      expect(command).toContain("cat >/dev/null");
      const result = spawnSync(command, {
        shell: true,
        cwd: process.cwd(),
        input: `${"x".repeat(1024 * 64)}\n`,
        encoding: "utf8",
        env: { ...process.env, CODEX_PLUGIN_ROOT: root },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("{}");
    }
  });

  test("Claude hooks fail open when dist/cli.js has not been built", async () => {
    const root = await tempRoot();
    const manifest = await loadManifest("hooks/claude.hooks.json");

    for (const command of commands(manifest)) {
      const result = spawnSync(command, {
        shell: true,
        cwd: process.cwd(),
        input: "{}",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("{}");
    }
  });
});
