import { describe, expect, it } from "vitest";
import {
  branchExists,
  fetchBranch,
  changedFiles,
  worktreePathForBranch,
  worktreePathUnder,
  salvageUncommitted,
  unquotePorcelainPath,
} from "../src/runtime/git.js";
import type { GitContext } from "../src/runtime/git.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

// A recording exec fake: each call is logged as `argv`, and the response is
// keyed by a matcher so a missing branch can return code 1 (rev-parse --verify
// --quiet semantics) while a present branch returns code 0.
function recordingExec(
  responder: (cmd: string, args: readonly string[]) => ExecOutput,
): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return responder(cmd, args);
  };
  return { exec, calls };
}

const ok = (stdout = ""): ExecOutput => ({ code: 0, stdout, stderr: "" });
const fail = (code = 1): ExecOutput => ({ code, stdout: "", stderr: "" });

describe("branchExists (FIX E)", () => {
  it("returns true when rev-parse --verify finds the local ref", async () => {
    const { exec, calls } = recordingExec(() => ok("deadbee\n"));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await branchExists(ctx, "afk/w/1-x")).toBe(true);
    expect(calls[0]).toEqual(["git", "rev-parse", "--verify", "--quiet", "refs/heads/afk/w/1-x"]);
  });

  it("returns false when the ref is absent (rev-parse exits non-zero)", async () => {
    const { exec } = recordingExec(() => fail());
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await branchExists(ctx, "afk/w/1-missing")).toBe(false);
  });

  it("returns false for an empty branch name without spawning git", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await branchExists(ctx, "")).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("fetchBranch (FIX E recovery)", () => {
  it("issues a best-effort git fetch origin <branch>", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };
    await fetchBranch(ctx, "afk/w/1-x");
    expect(calls[0]).toEqual(["git", "fetch", "origin", "afk/w/1-x"]);
  });

  it("no-ops for an empty branch name", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };
    await fetchBranch(ctx, "");
    expect(calls).toEqual([]);
  });
});

describe("changedFiles — the silent-empty hazard FIX E guards against", () => {
  it("returns [] (code 0) for a three-dot diff against a MISSING branch — the bypass risk", async () => {
    // git diff base...branch against a non-existent branch returns empty, code 0.
    // This is exactly why a presence check must precede the feedback gate.
    const { exec } = recordingExec((_c, args) => (args.includes("diff") ? ok("") : ok()));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await changedFiles(ctx, "afk/w/1-missing", "main")).toEqual([]);
  });

  it("parses the changed-file list for a real diff", async () => {
    const { exec } = recordingExec(() => ok("packages/x/src/a.ts\npackages/y/b.ts\n"));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await changedFiles(ctx, "afk/w/1-x", "main")).toEqual([
      "packages/x/src/a.ts",
      "packages/y/b.ts",
    ]);
  });
});

describe("worktreePathForBranch", () => {
  const porcelain = [
    "worktree /repo",
    "HEAD aaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.red/tmp/wt",
    "HEAD bbbbbbb",
    "branch refs/heads/afk/w/1-x",
    "",
  ].join("\n");

  it("resolves the worktree path checked out on the branch", async () => {
    const { exec, calls } = recordingExec(() => ok(porcelain));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await worktreePathForBranch(ctx, "afk/w/1-x")).toBe("/repo/.red/tmp/wt");
    expect(calls[0]).toEqual(["git", "worktree", "list", "--porcelain"]);
  });

  it("returns undefined when no worktree holds the branch", async () => {
    const { exec } = recordingExec(() => ok(porcelain));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await worktreePathForBranch(ctx, "afk/w/9-absent")).toBeUndefined();
  });
});

describe("worktreePathUnder (sandcastle-blind heartbeat fix)", () => {
  // sandcastle registers its worktree under the attempt dir; the legacy
  // `{attemptDir}/worktree` path the state seeds never exists.
  const porcelain = [
    "worktree /repo",
    "HEAD aaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.red/tmp/workers/wQDOR/894-a1/.sandcastle/worktrees/afk-wQDOR-894-x",
    "HEAD bbbbbbb",
    "branch refs/heads/afk/wQDOR/894-x",
    "",
  ].join("\n");

  it("resolves the real sandcastle worktree registered under the attempt dir", async () => {
    const { exec, calls } = recordingExec(() => ok(porcelain));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await worktreePathUnder(ctx, "/repo/.red/tmp/workers/wQDOR/894-a1")).toBe(
      "/repo/.red/tmp/workers/wQDOR/894-a1/.sandcastle/worktrees/afk-wQDOR-894-x",
    );
    expect(calls[0]).toEqual(["git", "worktree", "list", "--porcelain"]);
  });

  it("tolerates a trailing slash on the prefix", async () => {
    const { exec } = recordingExec(() => ok(porcelain));
    expect(await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/894-a1/")).toBe(
      "/repo/.red/tmp/workers/wQDOR/894-a1/.sandcastle/worktrees/afk-wQDOR-894-x",
    );
  });

  it("does not match a sibling attempt dir that only shares a prefix string", async () => {
    // `894-a1` must not match `894-a10` (guards the `startsWith(prefix + '/')` form).
    const { exec } = recordingExec(() => ok(porcelain));
    expect(await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/894-a")).toBeUndefined();
  });

  it("returns undefined when no worktree is registered under the prefix yet", async () => {
    const { exec } = recordingExec(() => ok("worktree /repo\nbranch refs/heads/main\n"));
    expect(await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/894-a1")).toBeUndefined();
  });
});

describe("unquotePorcelainPath", () => {
  it("passes a plain (unquoted) ASCII path through unchanged", () => {
    expect(unquotePorcelainPath("src/a.ts")).toBe("src/a.ts");
  });

  it("decodes octal-escaped UTF-8 bytes back to the unicode literal", () => {
    expect(unquotePorcelainPath('"caf\\303\\251.txt"')).toBe("café.txt");
  });

  it("decodes a multi-codepoint unicode name (emoji)", () => {
    // 🚀 is U+1F680 → UTF-8 F0 9F 9A 80 → octal \360\237\232\200.
    expect(unquotePorcelainPath('"\\360\\237\\232\\200.md"')).toBe("🚀.md");
  });

  it("unwraps a quoted path with a space and no escapes", () => {
    expect(unquotePorcelainPath('"na me.txt"')).toBe("na me.txt");
  });

  it("decodes named C escapes (tab, newline, escaped quote, backslash)", () => {
    expect(unquotePorcelainPath('"a\\tb.txt"')).toBe("a\tb.txt");
    expect(unquotePorcelainPath('"a\\nb.txt"')).toBe("a\nb.txt");
    expect(unquotePorcelainPath('"a\\"b.txt"')).toBe('a"b.txt');
    expect(unquotePorcelainPath('"a\\\\b.txt"')).toBe("a\\b.txt");
  });
});

describe("salvageUncommitted (codex DONE-without-commit)", () => {
  const porcelain = "worktree /repo/.red/tmp/wt\nHEAD bbb\nbranch refs/heads/afk/w/1-x\n";

  it("commits each dirty path one-per-file (scoped) and pushes once", async () => {
    const { exec, calls } = recordingExec((_c, args) => {
      if (args.includes("list")) return ok(porcelain);
      if (args.includes("status")) return ok(" M src/a.ts\n?? src/b.ts\n");
      return ok();
    });
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await salvageUncommitted(ctx, "afk/w/1-x")).toBe(2);

    const adds = calls.filter((c) => c[1] === "add");
    const commits = calls.filter((c) => c[1] === "commit");
    const pushes = calls.filter((c) => c[1] === "push");
    // one add + one commit per file, each scoped with `-- <path>`.
    expect(adds.map((c) => c[c.length - 1])).toEqual(["src/a.ts", "src/b.ts"]);
    expect(commits).toHaveLength(2);
    for (const c of commits) expect(c[c.length - 2]).toBe("--");
    // a single force-with-lease push of HEAD to the branch ref.
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual([
      "git",
      "push",
      "--force-with-lease",
      "origin",
      "HEAD:refs/heads/afk/w/1-x",
    ]);
  });

  it("un-escapes a C-quoted unicode porcelain path before staging", async () => {
    // git core.quotePath wraps non-ASCII paths in quotes AND octal-escapes each
    // raw UTF-8 byte: café.txt → "caf\303\251.txt". Stripping the quotes alone
    // leaves the backslash escapes, naming a file that doesn't exist → the work
    // is silently dropped. The literal path must reach `git add --`.
    const { exec, calls } = recordingExec((_c, args) => {
      if (args.includes("list")) return ok(porcelain);
      if (args.includes("status")) return ok('?? "caf\\303\\251.txt"\n');
      return ok();
    });
    expect(await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x")).toBe(1);
    const add = calls.find((c) => c[1] === "add")!;
    expect(add[add.length - 1]).toBe("café.txt");
    const commit = calls.find((c) => c[1] === "commit")!;
    expect(commit[commit.length - 1]).toBe("café.txt");
  });

  it("un-escapes a quoted path with a space and stages the literal name", async () => {
    const { exec, calls } = recordingExec((_c, args) => {
      if (args.includes("list")) return ok(porcelain);
      if (args.includes("status")) return ok('?? "na me.txt"\n');
      return ok();
    });
    expect(await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x")).toBe(1);
    const add = calls.find((c) => c[1] === "add")!;
    expect(add[add.length - 1]).toBe("na me.txt");
  });

  it("un-escapes the quoted destination path of a rename", async () => {
    const { exec, calls } = recordingExec((_c, args) => {
      if (args.includes("list")) return ok(porcelain);
      if (args.includes("status")) return ok('R  old.ts -> "caf\\303\\251.ts"\n');
      return ok();
    });
    expect(await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x")).toBe(1);
    const add = calls.find((c) => c[1] === "add")!;
    expect(add[add.length - 1]).toBe("café.ts");
  });

  it("commits the destination path of a rename", async () => {
    const { exec, calls } = recordingExec((_c, args) => {
      if (args.includes("list")) return ok(porcelain);
      if (args.includes("status")) return ok("R  old.ts -> new.ts\n");
      return ok();
    });
    expect(await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x")).toBe(1);
    const add = calls.find((c) => c[1] === "add")!;
    expect(add[add.length - 1]).toBe("new.ts");
  });

  it("no-ops (returns 0, no commit, no push) for a clean worktree", async () => {
    const { exec, calls } = recordingExec((_c, args) => (args.includes("list") ? ok(porcelain) : ok("")));
    expect(await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x")).toBe(0);
    expect(calls.some((c) => c[1] === "commit")).toBe(false);
    expect(calls.some((c) => c[1] === "push")).toBe(false);
  });

  it("returns 0 when no live worktree holds the branch", async () => {
    const { exec } = recordingExec(() => ok("worktree /repo\nbranch refs/heads/main\n"));
    expect(await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x")).toBe(0);
  });

  it("honours a custom remote in the push refspec", async () => {
    const { exec, calls } = recordingExec((_c, args) => {
      if (args.includes("list")) return ok(porcelain);
      if (args.includes("status")) return ok(" M src/a.ts\n");
      return ok();
    });
    await salvageUncommitted({ cwd: "/repo", exec }, "afk/w/1-x", "upstream");
    const push = calls.find((c) => c[1] === "push")!;
    expect(push[3]).toBe("upstream");
  });
});
