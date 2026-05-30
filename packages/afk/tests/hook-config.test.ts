import { describe, expect, it } from "vitest";
import {
  CANONICAL_HOOK_NAMES,
  HOOK_DEFAULTS_REGISTRY,
  resolveHooks,
  type ResolvedHooks,
} from "../src/core/hook-config.js";

/**
 * Tests for hook-config.ts — the pure resolution of `afk.hooks.*` into an
 * ordered command list per lifecycle point. Ported from
 * scripts/tests/hook-config.test.sh, keeping the meaningful cases:
 * defaults-first ordering, user-after-defaults, bare-string normalization,
 * single-default disable, unknown-hook hard error, per-point attachment.
 *
 * The shell loader resolves against built-in default *scripts* whose presence
 * is gated by an executable-file check; here we inject the resolved default
 * commands so the resolution stays pure and IO-free.
 */

const DEFAULT_CMDS = {
  cargo: "defaults/cargo-pre-worktree.sh",
  gradle: "defaults/gradle-pre-worktree.sh",
  heartbeat: "defaults/heartbeat-post-attempt.sh",
  envelope: "defaults/envelope-post-attempt.sh",
  validation: "defaults/validation-post-merge.sh",
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

  it("disables exactly one default via defaults.<name>: false", () => {
    const resolved = resolve({ "afk.hooks.defaults.cargo": "false" });
    expect(resolved.pre_worktree).toEqual([DEFAULT_CMDS.gradle]);
    // gradle stays enabled; the other points are untouched
    expect(resolved.post_attempt).toEqual([
      DEFAULT_CMDS.heartbeat,
      DEFAULT_CMDS.envelope,
    ]);
  });

  it("only `false` disables a default — any other value keeps it", () => {
    const resolved = resolve({ "afk.hooks.defaults.cargo": "true" });
    expect(resolved.pre_worktree).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
    ]);
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
