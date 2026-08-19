import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_HOOK_NAMES,
  HOOK_DEFAULTS_REGISTRY,
  resolveHooks,
  validateHookConfig,
  UnknownHookError,
  scriptDefaultResolver,
  type ResolvedHooks,
} from "../src/core/hook-config.js";

/**
 * Tests for hook-config.ts — the pure resolution of `afk.hooks.*` into an
 * ordered command list per lifecycle point. Ported from
 * scripts/tests/hook-config.test.sh, keeping the meaningful cases:
 * defaults-first ordering, user-after-defaults, bare-string normalization,
 * shadowing (project script wins over lib), unknown-hook hard error,
 * per-point attachment, and legacy-toggle backward-compat (no error).
 *
 * The shell loader resolves against built-in `red-*` library scripts whose
 * presence is gated by an executable-file check; here we inject the resolved
 * default commands so the resolution stays pure and IO-free.
 */

const DEFAULT_CMDS = {
  cargo: "hooks/red-cargo",
  gradle: "hooks/red-gradle",
  heartbeat: "hooks/red-heartbeat",
  envelope: "hooks/red-envelope",
  validation: "hooks/red-validation",
} as const;

function defaultCommand(name: keyof typeof DEFAULT_CMDS): string {
  return DEFAULT_CMDS[name];
}

function resolve(config: Record<string, string>): ResolvedHooks {
  return resolveHooks(config, { defaultCommand });
}

describe("hook-config resolution", () => {
  it("does not resolve cargo or gradle defaults when the project has no matching build files", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-config-node-project-"));
    const libraryHooksDir = join(root, "library-hooks");
    mkdirSync(libraryHooksDir);
    writeFileSync(join(libraryHooksDir, "red-cargo"), "#!/usr/bin/env bash\n");
    writeFileSync(join(libraryHooksDir, "red-gradle"), "#!/usr/bin/env bash\n");

    const resolved = resolveHooks(
      {},
      {
        defaultCommand: scriptDefaultResolver(libraryHooksDir, {
          projectRoot: root,
        }),
      },
    );

    expect(resolved.pre_worktree).toEqual([]);
  });

  it("does not resolve a matching build hook when config disables that default", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-config-build-project-"));
    const libraryHooksDir = join(root, "library-hooks");
    mkdirSync(libraryHooksDir);
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "demo"\n');
    writeFileSync(join(root, "build.gradle.kts"), "// gradle\n");
    writeFileSync(join(libraryHooksDir, "red-cargo"), "#!/usr/bin/env bash\n");
    writeFileSync(join(libraryHooksDir, "red-gradle"), "#!/usr/bin/env bash\n");

    const resolved = resolveHooks(
      { "afk.hooks.defaults.cargo": "false" },
      {
        defaultCommand: scriptDefaultResolver(libraryHooksDir, {
          projectRoot: root,
        }),
      },
    );

    expect(resolved.pre_worktree).toEqual([
      join(libraryHooksDir, "red-gradle"),
    ]);
  });

  it("uses a project shadow after Node determines the build hook applies", () => {
    const root = mkdtempSync(join(tmpdir(), "hook-config-shadow-project-"));
    const libraryHooksDir = join(root, "library-hooks");
    const projectHooksDir = join(root, ".red", "hooks");
    mkdirSync(libraryHooksDir);
    mkdirSync(projectHooksDir, { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "demo"\n');
    writeFileSync(join(libraryHooksDir, "red-cargo"), "#!/usr/bin/env bash\n");
    const shadow = join(projectHooksDir, "red-cargo");
    writeFileSync(shadow, "#!/usr/bin/env bash\n");

    const resolved = resolveHooks(
      {},
      {
        defaultCommand: scriptDefaultResolver(libraryHooksDir, {
          projectHooksDir,
          projectRoot: root,
        }),
      },
    );

    expect(resolved.pre_worktree).toEqual([shadow]);
  });

  it("attaches built-in defaults to their lifecycle points", () => {
    const resolved = resolve({});
    expect(resolved.pre_worktree).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
    ]);
    expect(resolved.post_attempt).toEqual([
      DEFAULT_CMDS.heartbeat,
      DEFAULT_CMDS.envelope,
    ]);
    expect(resolved.post_merge).toEqual([DEFAULT_CMDS.validation]);
    // points with no defaults and no user hooks resolve to empty lists
    expect(resolved.pre_session).toEqual([]);
    expect(resolved.on_idle).toEqual([]);
  });

  it("normalizes a bare string to a one-element list", () => {
    const resolved = resolve({ "afk.hooks.pre_session": "echo boot" });
    expect(resolved.pre_session).toEqual(["echo boot"]);
  });

  it("preserves declaration order within a user hook list", () => {
    const resolved = resolve({
      "afk.hooks.post_session": ["first", "second", "third", "fourth"].join(
        "\n",
      ),
    });
    expect(resolved.post_session).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("runs built-in defaults first, then user-declared commands", () => {
    const resolved = resolve({
      "afk.hooks.pre_worktree": ["echo user-a", "echo user-b"].join("\n"),
    });
    expect(resolved.pre_worktree).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
      "echo user-a",
      "echo user-b",
    ]);
  });

  it("disables a built-in default via defaults.<name>: false", () => {
    const resolved = resolve({ "afk.hooks.defaults.cargo": "false" });
    expect(resolved.pre_worktree).toEqual([DEFAULT_CMDS.gradle]);
  });

  it("shadows a default via scriptDefaultResolver when projectHooksDir has a same-named script", () => {
    // Simulate: /project/.red/hooks/red-cargo exists (shadow).
    const resolver = scriptDefaultResolver(
      "/lib/hooks",
      "/project/.red/hooks",
      (p) => p.startsWith("/project/.red/hooks/"),
    );
    expect(resolver("cargo")).toBe("/project/.red/hooks/red-cargo");
    // gradle has no shadow → falls through to lib.
    const resolverGradle = scriptDefaultResolver(
      "/lib/hooks",
      "/project/.red/hooks",
      (p) => p === "/lib/hooks/red-gradle",
    );
    expect(resolverGradle("gradle")).toBe("/lib/hooks/red-gradle");
    // heartbeat has no shadow and lib also missing → undefined.
    const resolverMissing = scriptDefaultResolver(
      "/lib/hooks",
      "/project/.red/hooks",
      () => false,
    );
    expect(resolverMissing("heartbeat")).toBeUndefined();
  });

  it("throws a hard error on an unknown hook name", () => {
    expect(() =>
      resolve({ "afk.hooks.pre_doesnotexist": "echo nope" }),
    ).toThrow(/unknown hook name 'pre_doesnotexist'/);
  });

  it("mixes bare-string and block-list points, defaults intact", () => {
    const resolved = resolve({
      "afk.hooks.pre_session": "echo first",
      "afk.hooks.post_session": ["echo a", "echo b"].join("\n"),
    });
    expect(resolved.pre_session).toEqual(["echo first"]);
    expect(resolved.post_session).toEqual(["echo a", "echo b"]);
  });

  it("ignores empty lines inside a user hook list", () => {
    const resolved = resolve({
      "afk.hooks.post_session": ["echo a", "", "echo b", ""].join("\n"),
    });
    expect(resolved.post_session).toEqual(["echo a", "echo b"]);
  });

  it("exposes the canonical name set and the per-point defaults registry", () => {
    expect(CANONICAL_HOOK_NAMES).toContain("pre_attempt");
    expect(CANONICAL_HOOK_NAMES).toContain("post_attempt");
    expect(CANONICAL_HOOK_NAMES).not.toContain("post_worker");
    expect(HOOK_DEFAULTS_REGISTRY.pre_worktree).toEqual(["cargo", "gradle"]);
    expect(HOOK_DEFAULTS_REGISTRY.post_attempt).toEqual([
      "heartbeat",
      "envelope",
    ]);
    expect(HOOK_DEFAULTS_REGISTRY.post_merge).toEqual(["validation"]);
  });

  it("registers the #832 recovery/feedback checkpoints as canonical (no default attaches)", () => {
    const names = [
      "pre_feedback",
      "on_baseline_probe",
      "post_feedback",
      "on_recovery_decision",
      "on_blocked",
      "on_reconcile",
    ] as const;
    for (const name of names) {
      expect(CANONICAL_HOOK_NAMES).toContain(name);
      // None of the new points ship a built-in default → resolve to the empty list.
      expect(resolve({})[name]).toEqual([]);
    }
  });

  it("resolves YAML list-form (indexed keys) identically to the newline-joined scalar form", () => {
    const listForm = resolve({
      "afk.hooks.pre_session.0": "echo first",
      "afk.hooks.pre_session.1": "echo second",
      "afk.hooks.pre_session.2": "echo third",
    });
    const scalarForm = resolve({
      "afk.hooks.pre_session": ["echo first", "echo second", "echo third"].join(
        "\n",
      ),
    });
    expect(listForm.pre_session).toEqual([
      "echo first",
      "echo second",
      "echo third",
    ]);
    expect(listForm.pre_session).toEqual(scalarForm.pre_session);
  });

  it("pins dispatch order for list-form hooks by explicit index", () => {
    const resolved = resolve({
      "afk.hooks.post_session.2": "echo c",
      "afk.hooks.post_session.0": "echo a",
      "afk.hooks.post_session.1": "echo b",
    });
    expect(resolved.post_session).toEqual(["echo a", "echo b", "echo c"]);
  });

  it("list-form for any lifecycle point does not throw UnknownHookError", () => {
    for (const name of CANONICAL_HOOK_NAMES) {
      expect(() =>
        resolve({ [`afk.hooks.${name}.0`]: "echo test" }),
      ).not.toThrow();
    }
  });

  it("list-form and bare-string form for the same point merge in index-then-scalar order", () => {
    // Indexed entries sort before the bare scalar (which uses MAX_SAFE_INTEGER as index).
    const resolved = resolve({
      "afk.hooks.post_session": "echo bare",
      "afk.hooks.post_session.0": "echo indexed",
    });
    expect(resolved.post_session).toEqual(["echo indexed", "echo bare"]);
  });

  it("throws UnknownHookError for a genuinely unknown hook name in indexed form", () => {
    expect(() =>
      resolve({ "afk.hooks.not_a_real_hook.0": "echo nope" }),
    ).toThrow(/unknown hook name 'not_a_real_hook'/);
  });

  it("validateHookConfig passes a valid config silently", () => {
    expect(() =>
      validateHookConfig({
        "afk.hooks.pre_session": "echo boot",
        "afk.hooks.pre_merge.0": "echo first",
        "afk.hooks.pre_merge.1": "echo second",
      }),
    ).not.toThrow();
  });

  it("validateHookConfig throws UnknownHookError naming the offending key", () => {
    let caught: unknown;
    try {
      validateHookConfig({ "afk.hooks.bad_hook_name": "echo nope" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownHookError);
    expect((caught as UnknownHookError).hookName).toBe("bad_hook_name");
  });

  it("validateHookConfig throws for a malformed key that does not match name[.N]", () => {
    expect(() =>
      validateHookConfig({ "afk.hooks.pre_session.foo": "echo nope" }),
    ).toThrow(UnknownHookError);
  });
});
