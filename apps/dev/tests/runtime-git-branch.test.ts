import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  branchExists,
  branchReversionBaseline,
  fetchBranch,
  fetchBranchRequired,
  FLEET_TRUNK_REF,
  changedFiles,
  prepareFreshWorkerBranch,
  resolveFreshBase,
  worktreePathForBranch,
  worktreePathUnder,
  unquotePorcelainPath,
  listRemoteBranches,
  listMergedLocalBranches,
  branchCommitsAhead,
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
const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

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

describe("fetchBranchRequired (safety barriers)", () => {
  it("fetches the named remote before reading safety geometry", async () => {
    const { exec, calls } = recordingExec(() => ok());
    const ctx: GitContext = { cwd: "/repo", exec };

    await fetchBranchRequired(ctx, "main", "upstream");

    expect(calls[0]).toEqual(["git", "fetch", "upstream", "main"]);
  });

  it("rejects a failed fetch instead of reading a stale tracking ref", async () => {
    const { exec } = recordingExec(() => fail());
    const ctx: GitContext = { cwd: "/repo", exec };

    await expect(fetchBranchRequired(ctx, "main", "origin")).rejects.toThrow(
      "required git fetch failed for origin/main",
    );
  });
});

describe("branchReversionBaseline", () => {
  it("pins the base SHA so both geometry patches share immutable coordinates", async () => {
    const { exec, calls } = recordingExec((_cmd, args) => {
      if (args.join(" ") === "rev-parse --verify origin/main^{commit}") return ok("base-sha\n");
      if (args.join(" ") === "merge-base base-sha afk/w/9-x") return ok("fork-sha\n");
      if (args.at(-1) === "fork-sha..base-sha") return ok("after-fork patch");
      return fail();
    });

    await expect(
      branchReversionBaseline({ cwd: "/repo", exec }, "afk/w/9-x", "origin/main"),
    ).resolves.toEqual({
      forkPoint: "fork-sha",
      afterForkBasePatch: "after-fork patch",
      baseRef: "base-sha",
    });
    expect(calls.some((call) => call.at(-1) === "fork-sha..origin/main")).toBe(false);
  });
});

describe("resolveFreshBase (manual requeue base refresh)", () => {
  it("fetches the base, advances the fleet mirror, and returns that mirror as the worktree base", async () => {
    const { exec, calls } = recordingExec((_cmd, args) => {
      const joined = args.join(" ");
      if (joined === "fetch origin main") return ok("");
      if (joined === "rev-parse --verify --quiet origin/main") return ok("remote-tip\n");
      if (joined === `rev-parse --verify --quiet ${FLEET_TRUNK_REF}`) return ok("old-mirror\n");
      if (joined === `merge-base --is-ancestor ${FLEET_TRUNK_REF} origin/main`) return ok("");
      if (joined === `update-ref ${FLEET_TRUNK_REF} remote-tip`) return ok("");
      return fail();
    });

    await expect(resolveFreshBase({ cwd: "/repo", exec }, { base: "main", remote: "origin" })).resolves.toMatchObject({
      ok: true,
      baseRef: "red-trunk",
      sha: "remote-tip",
      source: "mirror",
      remoteReachable: true,
    });
    expect(calls[0]).toEqual(["git", "fetch", "origin", "main"]);
    expect(calls).toContainEqual(["git", "update-ref", FLEET_TRUNK_REF, "remote-tip"]);
    expect(calls.some((c) => c.includes("refs/heads/main"))).toBe(false);
    expect(calls.some((c) => c.includes("symbolic-ref") || c.includes("status"))).toBe(false);
  });

  it("resets the fleet mirror to origin when trunk history is rewritten", async () => {
    const { exec, calls } = recordingExec((_cmd, args) => {
      const joined = args.join(" ");
      if (joined === "fetch origin main") return ok("");
      if (joined === "rev-parse --verify --quiet origin/main") return ok("rewritten-tip\n");
      if (joined === `rev-parse --verify --quiet ${FLEET_TRUNK_REF}`) return ok("orphaned-mirror\n");
      if (joined === `merge-base --is-ancestor ${FLEET_TRUNK_REF} origin/main`) return fail();
      if (joined === `update-ref ${FLEET_TRUNK_REF} rewritten-tip`) return ok("");
      return fail();
    });

    await expect(resolveFreshBase({ cwd: "/repo", exec }, { base: "main", remote: "origin" })).resolves.toMatchObject({
      ok: true,
      baseRef: "red-trunk",
      sha: "rewritten-tip",
      source: "mirror",
      remoteReachable: true,
    });
    expect(calls).toContainEqual(["git", "update-ref", FLEET_TRUNK_REF, "rewritten-tip"]);
  });

  it("parks typed when origin cannot refresh the mirror instead of falling back to the primary branch", async () => {
    const { exec } = recordingExec((_cmd, args) => {
      const joined = args.join(" ");
      if (joined === "fetch origin main") {
        return { code: 128, stdout: "", stderr: "fatal: bad object refs/worktree/HEAD" };
      }
      if (joined === "rev-parse --verify --quiet origin/main") return ok("remote-tip\n");
      return fail();
    });

    await expect(resolveFreshBase({ cwd: "/repo", exec }, { base: "main", remote: "origin" })).resolves.toMatchObject({
      ok: false,
      reason: "base-stale",
      baseRef: "origin/main",
      sha: "remote-tip",
      source: "mirror",
      remoteReachable: false,
      message: expect.stringContaining("fatal: bad object refs/worktree/HEAD"),
    });
  });
});

describe("prepareFreshWorkerBranch (merge-conflict retry freshness)", () => {
  it("removes stale local and tracking state so the retry branch is recreated from the moved base tip", async () => {
    const root = await mkdtemp(join(tmpdir(), "fresh-worker-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    const staleWt = join(root, "stale-wt");
    const retryWt = join(root, "retry-wt");
    const branch = "afk/w1213/9-conflict";

    try {
      await git(root, ["init", "--bare", "--initial-branch=main", origin]);
      await git(root, ["clone", origin, repo]);
      await git(repo, ["config", "user.email", "agent@example.test"]);
      await git(repo, ["config", "user.name", "Agent"]);

      await writeFile(join(repo, "base.txt"), "base one\n");
      await git(repo, ["add", "base.txt"]);
      await git(repo, ["commit", "-m", "base one"]);
      await git(repo, ["push", "-u", "origin", "main"]);

      await git(repo, ["checkout", "-b", branch]);
      await writeFile(join(repo, "attempt.txt"), "stale attempt\n");
      await git(repo, ["add", "attempt.txt"]);
      await git(repo, ["commit", "-m", "stale attempt"]);
      await git(repo, ["push", "origin", `HEAD:refs/heads/${branch}`]);
      await git(repo, ["checkout", "main"]);
      await git(repo, ["worktree", "add", staleWt, branch]);

      await writeFile(join(repo, "base.txt"), "base two\n");
      await git(repo, ["add", "base.txt"]);
      await git(repo, ["commit", "-m", "base two"]);
      await git(repo, ["push", "origin", "main"]);
      await git(repo, ["fetch", "origin", "main"]);
      const movedBaseTip = await git(repo, ["rev-parse", "origin/main"]);

      await expect(
        prepareFreshWorkerBranch({ cwd: repo }, { branch, baseRef: "origin/main", remote: "origin", force: true }),
      ).resolves.toBe(true);

      await expect(git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).rejects.toThrow();
      await expect(
        git(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]),
      ).rejects.toThrow();
      await expect(git(repo, ["ls-remote", "--exit-code", "--heads", "origin", branch])).rejects.toThrow();

      await git(repo, ["worktree", "add", "-b", branch, retryWt, "origin/main"]);
      const retryMergeBase = await git(repo, ["merge-base", branch, "origin/main"]);
      expect(retryMergeBase).toBe(movedBaseTip);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a current branch alone when its merge-base is already the base tip", async () => {
    const { exec, calls } = recordingExec((_cmd, args) => {
      const joined = args.join(" ");
      if (joined === "rev-parse --verify --quiet origin/main") return ok("base-tip\n");
      if (joined === "rev-parse --verify --quiet refs/heads/afk/w/1-current") return ok("branch-tip\n");
      if (joined === "rev-parse --verify --quiet refs/remotes/origin/afk/w/1-current") return fail();
      if (joined === "worktree list --porcelain") return ok("");
      if (joined === "merge-base afk/w/1-current origin/main") return ok("base-tip\n");
      return ok("");
    });

    await expect(
      prepareFreshWorkerBranch(
        { cwd: "/repo", exec },
        { branch: "afk/w/1-current", baseRef: "origin/main", remote: "origin", force: false },
      ),
    ).resolves.toBe(false);

    expect(calls.some((c) => c.includes("update-ref"))).toBe(false);
    expect(calls.some((c) => c.includes("-D"))).toBe(false);
  });
});

describe("listRemoteBranches", () => {
  it("fills commitS from a locally-present remote branch commit", async () => {
    const { exec, calls } = recordingExec((_cmd, args) => {
      if (args[0] === "ls-remote") return ok("abc123\trefs/heads/afk/w1/7-task\n");
      if (args[0] === "show") return ok("1700000123\n");
      return fail();
    });

    await expect(listRemoteBranches({ cwd: "/repo", exec }, "afk/")).resolves.toEqual([
      { branch: "afk/w1/7-task", commitS: 1700000123 },
    ]);
    expect(calls.map((c) => c.slice(1))).toEqual([
      ["ls-remote", "--heads", "origin", "refs/heads/afk/*"],
      ["show", "-s", "--format=%ct", "abc123"],
    ]);
  });

  it("fetches the specific remote branch when the commit object is not local yet", async () => {
    let showCount = 0;
    const { exec, calls } = recordingExec((_cmd, args) => {
      if (args[0] === "ls-remote") return ok("def456\trefs/heads/afk/w2/8-task\n");
      if (args[0] === "show") {
        showCount += 1;
        return showCount === 1 ? fail() : ok("1700000456\n");
      }
      if (args[0] === "fetch") return ok("");
      return fail();
    });

    await expect(listRemoteBranches({ cwd: "/repo", exec }, "afk/")).resolves.toEqual([
      { branch: "afk/w2/8-task", commitS: 1700000456 },
    ]);
    expect(calls.map((c) => c.slice(1))).toEqual([
      ["ls-remote", "--heads", "origin", "refs/heads/afk/*"],
      ["show", "-s", "--format=%ct", "def456"],
      ["fetch", "--quiet", "--no-tags", "origin", "refs/heads/afk/w2/8-task:refs/remotes/origin/afk/w2/8-task"],
      ["show", "-s", "--format=%ct", "def456"],
    ]);
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
  // Castle registers the worktree at the conventional direct child.
  const porcelain = [
    "worktree /repo",
    "HEAD aaaaaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.red/tmp/workers/wQDOR/894/worktree",
    "HEAD bbbbbbb",
    "branch refs/heads/afk/wQDOR/894-x",
    "",
  ].join("\n");

  it("resolves the conventional worktree registered under the worker workspace", async () => {
    const { exec, calls } = recordingExec(() => ok(porcelain));
    const ctx: GitContext = { cwd: "/repo", exec };
    expect(await worktreePathUnder(ctx, "/repo/.red/tmp/workers/wQDOR/894")).toBe(
      "/repo/.red/tmp/workers/wQDOR/894/worktree",
    );
    expect(calls[0]).toEqual(["git", "worktree", "list", "--porcelain"]);
  });

  it("tolerates a trailing slash on the prefix", async () => {
    const { exec } = recordingExec(() => ok(porcelain));
    expect(await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/894/")).toBe(
      "/repo/.red/tmp/workers/wQDOR/894/worktree",
    );
  });

  it("does not accept a castle-branded nested path through the normal reader", async () => {
    const legacy = [
      "worktree /repo/.red/tmp/workers/wQDOR/894/.red-castle/worktrees/afk-wQDOR-894-x",
      "branch refs/heads/afk/wQDOR/894-x",
      "",
    ].join("\n");
    const { exec } = recordingExec(() => ok(legacy));
    expect(
      await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/894"),
    ).toBeUndefined();
  });

  it("does not match a sibling workspace that only shares a prefix string", async () => {
    const { exec } = recordingExec(() => ok(porcelain));
    expect(await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/89")).toBeUndefined();
  });

  it("returns undefined when no worktree is registered under the prefix yet", async () => {
    const { exec } = recordingExec(() => ok("worktree /repo\nbranch refs/heads/main\n"));
    expect(await worktreePathUnder({ cwd: "/repo", exec }, "/repo/.red/tmp/workers/wQDOR/894")).toBeUndefined();
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

describe("exit-time salvage surface (ADR 0103)", () => {
  it("exports no salvage-uncommitted or exit-barrier push helper", async () => {
    // ADR 0103 retired the exit barrier and its salvage step: uncommitted work is
    // disposable, so the runtime git surface must not offer a way to commit a
    // dirty worktree (or push a branch "one last time") on the way out. A
    // reintroduced helper fails here before it can grow call sites.
    const gitModule = await import("../src/runtime/git.js");
    expect(Object.keys(gitModule)).not.toContain("salvageUncommitted");
    expect(Object.keys(gitModule)).not.toContain("pushBranch");
  });
});

describe("listMergedLocalBranches reads the landed fact (#2866)", () => {
  it("asks git which matching branches the base already carries", async () => {
    const { exec, calls } = recordingExec(() => ok("afk/9-landed\nafk/3-also-landed\n"));
    const ctx: GitContext = { cwd: "/repo", exec };
    const merged = await listMergedLocalBranches(ctx, "afk/*", "origin/main");
    expect(merged).toEqual(["afk/9-landed", "afk/3-also-landed"]);
    expect(calls[0]).toEqual([
      "git",
      "branch",
      "--list",
      "afk/*",
      "--merged",
      "origin/main",
      "--format=%(refname:short)",
    ]);
  });

  it("reports NOTHING landed when git cannot resolve the base", async () => {
    // Under-reporting spares every branch; over-reporting deletes unlanded work.
    const { exec } = recordingExec(() => fail());
    expect(await listMergedLocalBranches({ cwd: "/repo", exec }, "afk/*", "origin/main")).toEqual([]);
  });

  it("asks git nothing at all when no base was resolved", async () => {
    const { exec, calls } = recordingExec(() => ok("afk/9-landed\n"));
    expect(await listMergedLocalBranches({ cwd: "/repo", exec }, "afk/*", "")).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("branchCommitsAhead reads the remote tip, not a stale local ref (#2893)", () => {
  it("counts zero for a branch whose work already landed, even with a stale local branch of the same name", async () => {
    const root = await mkdtemp(join(tmpdir(), "commits-ahead-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    const branch = "afk/2888-memory-sampler";

    try {
      await git(root, ["init", "--bare", "--initial-branch=main", origin]);
      await git(root, ["clone", origin, repo]);
      await git(repo, ["config", "user.email", "agent@example.test"]);
      await git(repo, ["config", "user.name", "Agent"]);

      await writeFile(join(repo, "base.txt"), "base\n");
      await git(repo, ["add", "base.txt"]);
      await git(repo, ["commit", "-m", "base"]);
      await git(repo, ["push", "-u", "origin", "main"]);

      // The worker's branch: one commit, pushed.
      await git(repo, ["checkout", "-b", branch]);
      await writeFile(join(repo, "slice.txt"), "the slice\n");
      await git(repo, ["add", "slice.txt"]);
      await git(repo, ["commit", "-m", "the slice"]);
      await git(repo, ["push", "origin", `HEAD:refs/heads/${branch}`]);
      const staleTip = await git(repo, ["rev-parse", "HEAD"]);

      const ctx: GitContext = { cwd: repo };
      expect(await branchCommitsAhead(ctx, branch, "origin/main")).toBe(1);

      // The branch is rewritten and force-pushed (a rebase before landing), and
      // that rewritten tip is what lands. The LOCAL ref is left behind pointing
      // at a commit `main` will never contain — the leftover that made a landed
      // slice read as 7 commits stranded.
      await git(repo, ["commit", "--amend", "-m", "the slice, rebased"]);
      await git(repo, ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);
      const landed = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["checkout", "main"]);
      await git(repo, ["merge", "--ff-only", landed]);
      await git(repo, ["push", "origin", "main"]);
      await git(repo, ["update-ref", `refs/heads/${branch}`, staleTip]);
      await git(repo, ["fetch", "origin", "main"]);

      expect(await git(repo, ["rev-list", "--count", `origin/main..refs/heads/${branch}`])).toBe("1");
      expect(await branchCommitsAhead(ctx, branch, "origin/main")).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
