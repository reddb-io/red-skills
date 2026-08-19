import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hookEnv,
  makeHookExec,
  makeHookResolveOptions,
} from "../src/runtime/hooks.js";
import { skillDirFromModule } from "../src/platform/skill-paths.js";
import { resolveHooks } from "../src/core/hook-config.js";

/**
 * Gap 6 (per-slot build isolation): the cargo/gradle pre_worktree defaults ship
 * inside the AFK skill at `<plugin>/hooks/red-*`. makeHookResolveOptions must
 * anchor its lib hooks dir on the plugin root (like hook-config.sh), NOT on the
 * consuming project's `.red/hooks/lib`, or the built-in defaults never register
 * and per-slot CARGO_TARGET_DIR / GRADLE_USER_HOME isolation never fires.
 *
 * From the SOURCE tree `skillDirFromModule` cannot find a `hooks/` directory
 * as an ancestor (the skill lives under plugins/, not above src/), so it throws
 * and the resolver falls back to the project path. We therefore verify the
 * resolution logic against the SHIPPED bundle location, which is what runs in
 * production.
 */
describe("makeHookResolveOptions (gap 6: built-in defaults anchor on the plugin)", () => {
  it("resolves cargo/gradle/heartbeat/envelope/validation from <plugin>/hooks when reachable", () => {
    let skillDir: string;
    try {
      // The bundle ships at <plugin>/bin/afk.mjs; resolve from there.
      const here = new URL(import.meta.url).pathname; // .../apps/plugin-dev/tests/runtime-hooks.test.ts
      const repoRoot = here.slice(0, here.indexOf("/apps/plugin-dev/"));
      const binMjs = join(
        repoRoot,
        "plugins",
        "dev",
        "skills",
        "engineering",
        "afk",
        "bin",
        "afk.mjs",
      );
      skillDir = skillDirFromModule(new URL(`file://${binMjs}`).href);
    } catch {
      // The skill/bundle isn't laid out in this checkout — skip the strong assertion.
      return;
    }
    const hooksDir = join(skillDir, "hooks");
    // Sanity: the shipped library hooks exist where we expect them.
    expect(existsSync(join(hooksDir, "red-cargo"))).toBe(true);
    expect(existsSync(join(hooksDir, "red-gradle"))).toBe(true);
    expect(existsSync(join(hooksDir, "red-heartbeat"))).toBe(true);
    expect(existsSync(join(hooksDir, "red-envelope"))).toBe(true);
    expect(existsSync(join(hooksDir, "red-validation"))).toBe(true);

    // resolveHooks must register the cargo + gradle defaults at pre_worktree.
    const resolved = resolveHooks(
      {},
      {
        defaultCommand: (name) => {
          const scripts: Record<string, string> = {
            cargo: "red-cargo",
            gradle: "red-gradle",
            heartbeat: "red-heartbeat",
            envelope: "red-envelope",
            validation: "red-validation",
          };
          const p = join(hooksDir, scripts[name]!);
          return existsSync(p) ? p : undefined;
        },
      },
    );
    expect(resolved.pre_worktree).toEqual([
      join(hooksDir, "red-cargo"),
      join(hooksDir, "red-gradle"),
    ]);
    expect(resolved.post_attempt).toContain(join(hooksDir, "red-heartbeat"));
    expect(resolved.post_merge).toContain(join(hooksDir, "red-validation"));
  });

  it("omits cargo and gradle defaults for a consuming repo with no matching build files", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-hooks-node-project-"));
    const skillDir = join(root, "installed-afk-skill");
    const hooksDir = join(skillDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    for (const script of ["red-cargo", "red-gradle", "red-heartbeat"]) {
      writeFileSync(join(hooksDir, script), "#!/usr/bin/env bash\n");
    }
    const opts = makeHookResolveOptions(root, () => skillDir);

    expect(opts.defaultCommand("cargo")).toBeUndefined();
    expect(opts.defaultCommand("gradle")).toBeUndefined();
    expect(opts.defaultCommand("heartbeat")).toBe(
      join(hooksDir, "red-heartbeat"),
    );
  });
});

describe("hookEnv (per-slot RED_AFK_SLOT in hook environment)", () => {
  it("includes RED_AFK_REPO, RED_AFK_ROOT, and RED_AFK_WORKSPACE always", () => {
    const env = hookEnv("owner/repo", "/repo");
    expect(env.RED_AFK_REPO).toBe("owner/repo");
    expect(env.RED_AFK_ROOT).toBe("/repo");
    expect(env.RED_AFK_WORKSPACE).toBe("/repo");
  });

  it("includes RED_AFK_RUNNER when the caller supplies the resolved runner", () => {
    expect(
      hookEnv("owner/repo", "/repo", undefined, "codex").RED_AFK_RUNNER,
    ).toBe("codex");
  });

  it("omits RED_AFK_SLOT when no slot is given", () => {
    const env = hookEnv("owner/repo", "/repo");
    expect(env.RED_AFK_SLOT).toBeUndefined();
  });

  it("includes RED_AFK_SLOT when a slot is given", () => {
    expect(hookEnv("owner/repo", "/repo", 0).RED_AFK_SLOT).toBe("0");
    expect(hookEnv("owner/repo", "/repo", 3).RED_AFK_SLOT).toBe("3");
  });

  it("each slot gets a distinct RED_AFK_SLOT value", () => {
    const slots = [0, 1, 2].map(
      (s) => hookEnv("owner/repo", "/repo", s).RED_AFK_SLOT,
    );
    expect(slots).toEqual(["0", "1", "2"]);
  });
});

describe("makeHookExec", () => {
  it("runs bash-only lifecycle hooks with bash instead of the host sh interpreter", async () => {
    const exec = makeHookExec(process.cwd());

    await expect(
      exec(
        "read -r _; shopt -s extglob; [[ foobar == +(foo|bar) ]] && printf 'extglob-ok'",
        {},
        "{}\n",
      ),
    ).resolves.toEqual({ code: 0, stdout: "extglob-ok" });
  });
});
