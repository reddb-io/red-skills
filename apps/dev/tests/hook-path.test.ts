import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  resolveDirScripts,
  resolveHooks,
  type HookName,
  type ListFiles,
} from "../src/core/hook-config.js";
import {
  dispatchHooks,
  type HookExec,
} from "../src/core/hook-dispatcher.js";

/**
 * Tests for the layered hook PATH runtime (issue #830).
 *
 * Covers: directory resolution (layering, shadowing, ordering), inline config
 * appended after dir scripts, the stdin/stdout mutate contract for dir-resolved
 * entries, and exit-code routing — per the acceptance criteria.
 */

const LIB_DIR = "/lib/hooks";
const PROJ_DIR = "/proj/.red/hooks";

// Fake filesystem helpers.
function makeListFiles(tree: Record<string, string[]>): ListFiles {
  return (dir) => tree[dir] ?? [];
}

function makeDirExists(dirs: Set<string>): (dir: string) => boolean {
  return (dir) => dirs.has(dir);
}

// No-op defaultCommand (no built-in defaults) so dir-script ordering is isolated.
const noDefaults = () => undefined;

describe("resolveDirScripts — basic resolution", () => {
  it("returns empty list when both dirs are undefined", () => {
    const scripts = resolveDirScripts("pre_session", undefined, undefined, () => [], () => false);
    expect(scripts).toEqual([]);
  });

  it("returns empty list when dirs exist but are empty", () => {
    const point = "pre_session";
    const libPoint = join(LIB_DIR, point);
    const projPoint = join(PROJ_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({ [libPoint]: [], [projPoint]: [] }),
      makeDirExists(new Set([libPoint, projPoint])),
    );
    expect(scripts).toEqual([]);
  });

  it("returns library scripts when only the library dir is populated", () => {
    const point = "pre_attempt";
    const libPoint = join(LIB_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({ [libPoint]: ["10-check.sh", "20-setup.sh"] }),
      makeDirExists(new Set([libPoint])),
    );
    expect(scripts).toEqual([join(libPoint, "10-check.sh"), join(libPoint, "20-setup.sh")]);
  });

  it("returns project scripts when only the project dir is populated", () => {
    const point = "post_attempt";
    const projPoint = join(PROJ_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({ [projPoint]: ["10-notify.sh"] }),
      makeDirExists(new Set([projPoint])),
    );
    expect(scripts).toEqual([join(projPoint, "10-notify.sh")]);
  });
});

describe("resolveDirScripts — shadowing (project wins on same filename)", () => {
  it("project script shadows library script with the same filename", () => {
    const point = "pre_merge";
    const libPoint = join(LIB_DIR, point);
    const projPoint = join(PROJ_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({
        [libPoint]: ["10-validate.sh"],
        [projPoint]: ["10-validate.sh"],
      }),
      makeDirExists(new Set([libPoint, projPoint])),
    );
    // Only one entry for the shared filename, resolved to the project path.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toBe(join(projPoint, "10-validate.sh"));
  });

  it("unique filenames from both dirs are all included", () => {
    const point = "post_merge";
    const libPoint = join(LIB_DIR, point);
    const projPoint = join(PROJ_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({
        [libPoint]: ["10-lib-only.sh", "20-shared.sh"],
        [projPoint]: ["20-shared.sh", "30-proj-only.sh"],
      }),
      makeDirExists(new Set([libPoint, projPoint])),
    );
    expect(scripts).toHaveLength(3);
    // 10-lib-only from library, 20-shared from project (shadow), 30-proj-only from project.
    expect(scripts[0]).toBe(join(libPoint, "10-lib-only.sh"));
    expect(scripts[1]).toBe(join(projPoint, "20-shared.sh"));
    expect(scripts[2]).toBe(join(projPoint, "30-proj-only.sh"));
  });

  it("a project no-op shadow effectively disables the library script (caller controls content)", () => {
    // The shadowing mechanic: if project has "10-foo.sh" it replaces the library's "10-foo.sh".
    // Whether that replacement is a no-op script is the operator's concern; the resolver just
    // uses the project path.
    const point = "on_idle";
    const libPoint = join(LIB_DIR, point);
    const projPoint = join(PROJ_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({
        [libPoint]: ["10-notify.sh"],
        [projPoint]: ["10-notify.sh"],
      }),
      makeDirExists(new Set([libPoint, projPoint])),
    );
    expect(scripts).toEqual([join(projPoint, "10-notify.sh")]);
  });
});

describe("resolveDirScripts — ordering (numeric-prefix lexical)", () => {
  it("sorts scripts by numeric prefix: 5- before 10- before 20-", () => {
    const point = "pre_session";
    const libPoint = join(LIB_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      undefined,
      makeListFiles({ [libPoint]: ["20-last.sh", "5-first.sh", "10-middle.sh"] }),
      makeDirExists(new Set([libPoint])),
    );
    expect(scripts).toEqual([
      join(libPoint, "5-first.sh"),
      join(libPoint, "10-middle.sh"),
      join(libPoint, "20-last.sh"),
    ]);
  });

  it("sorts ties (same prefix) lexically by full filename", () => {
    const point = "pre_pick";
    const libPoint = join(LIB_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      undefined,
      makeListFiles({ [libPoint]: ["10-zzz.sh", "10-aaa.sh", "10-mmm.sh"] }),
      makeDirExists(new Set([libPoint])),
    );
    expect(scripts).toEqual([
      join(libPoint, "10-aaa.sh"),
      join(libPoint, "10-mmm.sh"),
      join(libPoint, "10-zzz.sh"),
    ]);
  });

  it("files with no numeric prefix sort after all numbered files", () => {
    const point = "post_pick";
    const libPoint = join(LIB_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      undefined,
      makeListFiles({ [libPoint]: ["no-prefix.sh", "10-numbered.sh"] }),
      makeDirExists(new Set([libPoint])),
    );
    expect(scripts).toEqual([join(libPoint, "10-numbered.sh"), join(libPoint, "no-prefix.sh")]);
  });

  it("filters out hidden files (filenames starting with '.')", () => {
    const point = "on_heartbeat";
    const libPoint = join(LIB_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      undefined,
      makeListFiles({ [libPoint]: [".DS_Store", "10-run.sh", ".hidden"] }),
      makeDirExists(new Set([libPoint])),
    );
    expect(scripts).toEqual([join(libPoint, "10-run.sh")]);
  });

  it("mixed library + project scripts sort by numeric prefix across sources", () => {
    const point = "pre_worktree";
    const libPoint = join(LIB_DIR, point);
    const projPoint = join(PROJ_DIR, point);
    const scripts = resolveDirScripts(
      point,
      LIB_DIR,
      PROJ_DIR,
      makeListFiles({
        [libPoint]: ["10-lib.sh", "30-lib.sh"],
        [projPoint]: ["20-proj.sh"],
      }),
      makeDirExists(new Set([libPoint, projPoint])),
    );
    expect(scripts).toEqual([
      join(libPoint, "10-lib.sh"),
      join(projPoint, "20-proj.sh"),
      join(libPoint, "30-lib.sh"),
    ]);
  });
});

describe("resolveHooks — directory scripts inserted between defaults and inline config", () => {
  const DEFAULT_CMDS = {
    cargo: "defaults/cargo-pre-worktree.sh",
    gradle: "defaults/gradle-pre-worktree.sh",
    heartbeat: "defaults/heartbeat-post-attempt.sh",
    envelope: "defaults/envelope-post-attempt.sh",
    validation: "defaults/validation-post-merge.sh",
  } as const;

  function resolve(
    config: Record<string, string>,
    listFiles: ListFiles,
    dirs: Set<string>,
  ) {
    return resolveHooks(config, {
      defaultCommand: (name) => DEFAULT_CMDS[name],
      libraryHooksDir: LIB_DIR,
      projectHooksDir: PROJ_DIR,
      listFiles,
      dirExists: (d) => dirs.has(d),
    });
  }

  it("empty dirs produce the same output as before (defaults then inline)", () => {
    const resolved = resolve(
      { "afk.hooks.pre_worktree": "echo user" },
      makeListFiles({}),
      new Set(),
    );
    expect(resolved.pre_worktree).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
      "echo user",
    ]);
  });

  it("dir scripts appear after defaults and before inline config", () => {
    const point: HookName = "pre_worktree";
    const libPoint = join(LIB_DIR, point);
    const resolved = resolve(
      { "afk.hooks.pre_worktree": "echo inline" },
      makeListFiles({ [libPoint]: ["10-dir-script.sh"] }),
      new Set([libPoint]),
    );
    expect(resolved.pre_worktree).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
      join(libPoint, "10-dir-script.sh"),
      "echo inline",
    ]);
  });

  it("dir scripts appear before inline config even when there are no defaults", () => {
    const point: HookName = "pre_session";
    const projPoint = join(PROJ_DIR, point);
    const resolved = resolve(
      { "afk.hooks.pre_session": "echo inline" },
      makeListFiles({ [projPoint]: ["10-proj.sh"] }),
      new Set([projPoint]),
    );
    expect(resolved.pre_session).toEqual([join(projPoint, "10-proj.sh"), "echo inline"]);
  });

  it("inline multiline YAML block (newline-joined) runs after dir scripts", () => {
    const point: HookName = "post_session";
    const projPoint = join(PROJ_DIR, point);
    const resolved = resolve(
      { "afk.hooks.post_session": ["echo a", "echo b"].join("\n") },
      makeListFiles({ [projPoint]: ["10-dir.sh"] }),
      new Set([projPoint]),
    );
    expect(resolved.post_session).toEqual([
      join(projPoint, "10-dir.sh"),
      "echo a",
      "echo b",
    ]);
  });

  it("no dirs provided → resolveHooks skips directory resolution entirely", () => {
    const resolved = resolveHooks(
      { "afk.hooks.pre_session": "echo inline" },
      { defaultCommand: noDefaults },
    );
    expect(resolved.pre_session).toEqual(["echo inline"]);
  });
});

describe("directory-resolved scripts — stdin/stdout mutate contract and exit-code routing", () => {
  function fakeExec(
    script: Record<string, { code?: number; stdout?: string }>,
    calls?: Array<{ command: string; stdin: string }>,
  ): HookExec {
    return async (command, _env, stdin) => {
      calls?.push({ command, stdin });
      const entry = script[command] ?? {};
      return { code: entry.code ?? 0, stdout: entry.stdout ?? "" };
    };
  }

  it("a dir-resolved script can mutate context via JSON stdout", async () => {
    const dirScript = "/lib/hooks/pre_session/10-set-runner.sh";
    const result = await dispatchHooks(
      "pre_session",
      [dirScript],
      '{"runner":"claude"}',
      fakeExec({ [dirScript]: { code: 0, stdout: '{"runner":"hermes"}' } }),
    );
    expect(result.context).toBe('{"runner":"hermes"}');
    expect(result.aborted).toBe(false);
  });

  it("a dir-resolved script with empty stdout leaves context unchanged", async () => {
    const dirScript = "/lib/hooks/post_attempt/10-notify.sh";
    const result = await dispatchHooks(
      "post_attempt",
      [dirScript],
      '{"n":1}',
      fakeExec({ [dirScript]: { code: 0, stdout: "" } }),
    );
    expect(result.context).toBe('{"n":1}');
    expect(result.aborted).toBe(false);
  });

  it("context threads through dir script then inline command in order", async () => {
    const dirScript = "/proj/.red/hooks/pre_session/10-enrich.sh";
    const inlineCmd = "echo-runner";
    const calls: Array<{ command: string; stdin: string }> = [];

    const result = await dispatchHooks(
      "pre_session",
      [dirScript, inlineCmd],
      '{"runner":"claude"}',
      fakeExec(
        {
          [dirScript]: { code: 0, stdout: '{"runner":"hermes","enriched":true}' },
          [inlineCmd]: { code: 0, stdout: "" },
        },
        calls,
      ),
    );
    // inline command received the dir script's mutated context on stdin
    expect(calls[1]!.stdin).toBe('{"runner":"hermes","enriched":true}');
    expect(result.context).toBe('{"runner":"hermes","enriched":true}');
  });

  it("a pre_* dir-resolved script that fails aborts the chain (abort policy)", async () => {
    const dirScript = "/lib/hooks/pre_merge/10-gate.sh";
    const inlineCmd = "echo never";
    const calls: Array<{ command: string; stdin: string }> = [];

    const result = await dispatchHooks(
      "pre_merge",
      [dirScript, inlineCmd],
      "{}",
      fakeExec({ [dirScript]: { code: 2, stdout: "" } }, calls),
    );
    expect(result.aborted).toBe(true);
    expect(result.rc).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("a post_* dir-resolved script that fails continues the chain (continue policy)", async () => {
    const dirScript = "/lib/hooks/post_attempt/10-notify.sh";
    const inlineCmd = "echo after";
    const calls: Array<{ command: string; stdin: string }> = [];

    const result = await dispatchHooks(
      "post_attempt",
      [dirScript, inlineCmd],
      "{}",
      fakeExec(
        {
          [dirScript]: { code: 9, stdout: "" },
          [inlineCmd]: { code: 0, stdout: '{"done":true}' },
        },
        calls,
      ),
    );
    expect(result.aborted).toBe(false);
    expect(result.rc).toBe(0);
    expect(result.context).toBe('{"done":true}');
    expect(calls).toHaveLength(2);
  });

  it("non-JSON stdout from a dir-resolved script under abort policy propagates rc=65", async () => {
    const dirScript = "/lib/hooks/pre_attempt/10-bad.sh";
    const result = await dispatchHooks(
      "pre_attempt",
      [dirScript],
      "{}",
      fakeExec({ [dirScript]: { code: 0, stdout: "oops not json" } }),
    );
    expect(result.aborted).toBe(true);
    expect(result.rc).toBe(65);
  });
});
