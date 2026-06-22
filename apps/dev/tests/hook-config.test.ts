import { describe, expect, it } from "vitest";
import {
  CANONICAL_HOOK_NAMES,
  HOOK_DEFAULTS_REGISTRY,
  resolveHooks,
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
      "afk.hooks.post_session": ["first", "second", "third", "fourth"].join("\n"),
    });
    expect(resolved.post_session).toEqual(["first", "second", "third", "fourth"]);
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

  it("silently ignores legacy defaults.<name>: false toggles (no error, no disable)", () => {
    // Old configs may still carry afk.hooks.defaults.cargo: false — these are
    // now silently ignored (shadowing in .red/hooks/ is the new mechanism).
    const resolved = resolve({ "afk.hooks.defaults.cargo": "false" });
    // cargo is still present — the legacy toggle no longer disables it.
    expect(resolved.pre_worktree).toEqual([DEFAULT_CMDS.cargo, DEFAULT_CMDS.gradle]);
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
    const resolverMissing = scriptDefaultResolver("/lib/hooks", "/project/.red/hooks", () => false);
    expect(resolverMissing("heartbeat")).toBeUndefined();
  });

  it("throws a hard error on an unknown hook name", () => {
    expect(() => resolve({ "afk.hooks.pre_doesnotexist": "echo nope" })).toThrow(
      /unknown hook name 'pre_doesnotexist'/,
    );
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
    expect(HOOK_DEFAULTS_REGISTRY.post_attempt).toEqual(["heartbeat", "envelope"]);
    expect(HOOK_DEFAULTS_REGISTRY.post_merge).toEqual(["validation"]);
  });
});
