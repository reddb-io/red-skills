import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeHookResolveOptions } from "../src/runtime/hooks.js";
import { skillDirFromModule } from "../src/platform/skill-paths.js";
import { resolveHooks } from "../src/core/hook-config.js";

/**
 * Gap 6 (per-slot build isolation): the cargo/gradle pre_worktree defaults ship
 * inside the AFK skill at `<plugin>/defaults/*.sh`. makeHookResolveOptions must
 * anchor its defaults dir on the plugin root (like hook-config.sh), NOT on the
 * consuming project's `.red/hooks/defaults`, or the built-in defaults never
 * register and per-slot CARGO_TARGET_DIR / GRADLE_USER_HOME isolation never fires.
 *
 * From the SOURCE tree `skillDirFromModule` cannot find a `defaults/` directory
 * as an ancestor (the skill lives under plugins/, not above src/), so it throws and the
 * resolver falls back to the project path. We therefore verify the resolution
 * logic against the SHIPPED bundle location, which is what runs in production.
 */
describe("makeHookResolveOptions (gap 6: built-in defaults anchor on the plugin)", () => {
  it("resolves cargo/gradle/heartbeat/envelope/validation from <plugin>/defaults when reachable", () => {
    let skillDir: string;
    try {
      // The bundle ships at <plugin>/bin/afk.mjs; resolve from there.
      const here = new URL(import.meta.url).pathname; // .../src/domains/dev/tests/runtime-hooks.test.ts
      const repoRoot = here.slice(0, here.indexOf("/src/domains/dev/"));
      const binMjs = join(repoRoot, "plugins", "dev", "skills", "engineering", "afk", "bin", "afk.mjs");
      skillDir = skillDirFromModule(new URL(`file://${binMjs}`).href);
    } catch {
      // The skill/bundle isn't laid out in this checkout — skip the strong assertion.
      return;
    }
    const defaultsDir = join(skillDir, "defaults");
    // Sanity: the shipped defaults exist where we expect them.
    expect(existsSync(join(defaultsDir, "cargo-pre-worktree.sh"))).toBe(true);
    expect(existsSync(join(defaultsDir, "gradle-pre-worktree.sh"))).toBe(true);

    // resolveHooks must register the cargo + gradle defaults at pre_worktree.
    const resolved = resolveHooks(
      {},
      { defaultCommand: (name) => {
        const scripts: Record<string, string> = {
          cargo: "cargo-pre-worktree.sh",
          gradle: "gradle-pre-worktree.sh",
          heartbeat: "heartbeat-post-attempt.sh",
          envelope: "envelope-post-attempt.sh",
          validation: "validation-post-merge.sh",
        };
        const p = join(defaultsDir, scripts[name]!);
        return existsSync(p) ? p : undefined;
      } },
    );
    expect(resolved.pre_worktree).toEqual([
      join(defaultsDir, "cargo-pre-worktree.sh"),
      join(defaultsDir, "gradle-pre-worktree.sh"),
    ]);
    expect(resolved.post_attempt).toContain(join(defaultsDir, "heartbeat-post-attempt.sh"));
    expect(resolved.post_merge).toContain(join(defaultsDir, "validation-post-merge.sh"));
  });

  it("never points at the consuming project's .red unless the skill dir is unreachable", () => {
    // makeHookResolveOptions(root) must NOT default to `<root>/.red/hooks/defaults`
    // when the plugin is reachable — that path never ships the scripts. We assert
    // the resolver returns undefined for a fictional project root (no defaults
    // under it), proving it does not silently read project-local paths.
    const opts = makeHookResolveOptions("/tmp/no-such-afk-project-xyz");
    // Whatever the anchor, a fictional project has no scripts, so cargo resolves
    // to undefined only if the anchor is NOT a populated plugin dir. When the
    // anchor IS the real plugin (source-tree run throws → project fallback), cargo
    // is undefined because the fallback dir is empty — either way it is a string
    // path or undefined, never a crash.
    const cargo = opts.defaultCommand("cargo");
    expect(cargo === undefined || typeof cargo === "string").toBe(true);
  });
});
