import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

// The hook manifests stayed at the plugin definition root
// (plugins/memory/hooks/) after the impl moved to apps/plugin-memory (ADR 0060).
// Resolve them relative to this test file, independent of the run cwd:
// tests/ -> memory -> apps -> repo root.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hookManifest = (name: string): string =>
  join(REPO_ROOT, "plugins", "memory", "hooks", name);

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
  // ADR 0029: hooks invoke the committed bootstrap, which fetches the runtime.
  // No `dist/cli.js`, no build-on-machine fallback.
  test("every hook invokes scripts/bootstrap.mjs and never dist/cli.js", async () => {
    for (const file of [hookManifest("claude.hooks.json"), hookManifest("codex.hooks.json")]) {
      const manifest = await loadManifest(file);
      const cmds = commands(manifest);
      expect(cmds.length).toBeGreaterThan(0);
      for (const command of cmds) {
        expect(command).toContain("scripts/bootstrap.mjs");
        expect(command).not.toContain("dist/cli.js");
      }
    }
  });

  test("Codex hooks drain stdin before delegating", async () => {
    const manifest = await loadManifest(hookManifest("codex.hooks.json"));
    for (const command of commands(manifest)) {
      expect(command).toContain('cat >"$tmp"');
    }
  });

  test("Codex documents the PreCompact degradation by wiring Stop and SessionStart only", async () => {
    const manifest = await loadManifest(hookManifest("codex.hooks.json"));

    expect(Object.keys(manifest.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    expect(manifest.hooks).not.toHaveProperty("PreCompact");
    expect(commands(manifest).filter((command) => command.includes(" hook Stop "))).toHaveLength(1);
    expect(commands(manifest).filter((command) => command.includes(" hook SessionStart "))).toHaveLength(1);
  });

  test("Claude hooks fail open to {} when the runtime cannot be resolved", async () => {
    const root = await tempRoot();
    const manifest = await loadManifest(hookManifest("claude.hooks.json"));

    for (const command of commands(manifest)) {
      // A bogus plugin root has no scripts/bootstrap.mjs, so node errors and the
      // `|| printf "{}"` guard keeps the hook a no-op instead of breaking the session.
      const result = spawnSync(command, {
        shell: true,
        cwd: process.cwd(),
        input: "{}\n",
        encoding: "utf8",
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: root },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("{}");
    }
  });

  test("Codex hooks fail open to {} when the runtime cannot be resolved", async () => {
    const root = await tempRoot();
    const manifest = await loadManifest(hookManifest("codex.hooks.json"));

    for (const command of commands(manifest)) {
      const result = spawnSync(command, {
        shell: true,
        cwd: process.cwd(),
        input: "{}\n",
        encoding: "utf8",
        env: { ...process.env, CODEX_PLUGIN_ROOT: root },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("{}");
    }
  });
});
