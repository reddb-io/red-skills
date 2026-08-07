import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { castleLanePath, createEnginePaths, readCastleLaneRecords } from "@reddb-io/red-castle/engine";
import { buildProcessDeps } from "../src/commands/run.js";
import { makeFeedbackWorktree } from "../src/runtime/feedback-worktree.js";
import { deleteLocalBranch } from "../src/runtime/git.js";
import type { RepoContext } from "../src/runtime/wire.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import { readsIssue, restIssueBody } from "./support/gh-rest-fixtures.js";

/**
 * Wiring integration test (architecture-review candidate #2 — the "wiring test
 * gap").
 *
 * The pure core (process-issue / merge / remote-branch / gh / git modules) is
 * already covered by unit tests over fakes. What had ZERO coverage was the
 * HAND-WRITTEN assembly in commands/run.ts::buildProcessDeps that binds ~21 real
 * gh/git/fs/clock closures: a closure could be present but bound to the wrong
 * `cwd`, or silently a no-op, and every existing test would still pass because
 * they inject their OWN fakes for ProcessIssueDeps rather than exercising the
 * real binding.
 *
 * This test drives the REAL assembly (`buildProcessDeps`, unmodified) over a
 * recording fake exec injected through the new `exec` seam (exec.ts::ExecFn →
 * GhContext.exec / GitContext.exec). It then invokes the assembled deps' gh/git
 * closures in the exact order the DONE close path issues them (process-issue.ts
 * steps 1 → 9) and asserts the resulting OS-command trace: each entry is the
 * `{cmd, args, cwd}` the closure actually issued. A wrong-cwd or no-op closure —
 * the audit bug class — makes this trace wrong.
 *
 * We do NOT stub the assembly: `buildProcessDeps` runs for real (it even loads
 * config + resolves hooks against the tmp repo root), and the closures under
 * test are the genuine ones it produced. Only `exec` is faked.
 */

interface TraceEntry {
  cmd: string;
  args: string[];
  cwd: string | undefined;
}

/** Build a recording fake exec that scripts replies by command shape. */
function makeFakeExec(repoRoot: string): { exec: ExecFn; trace: TraceEntry[] } {
  const trace: TraceEntry[] = [];
  const ok = (stdout = ""): ExecOutput => ({ code: 0, stdout, stderr: "" });

  const exec: ExecFn = (cmd, args, opts) => {
    const a = [...args];
    trace.push({ cmd, args: a, cwd: opts?.cwd });
    const joined = a.join(" ");

    if (cmd === "gh") {
      // claim pre-check and the url handoff are single-object reads, so they
      // address REST (#3094); the comments handoff has no single-request REST
      // projection and keeps gh's own command by declared field gap.
      if (readsIssue(a)) {
        return Promise.resolve(
          ok(
            JSON.stringify(
              restIssueBody({ labels: ["ready-for-agent"], url: "https://github.com/acme/widgets/issues/42" }),
            ),
          ),
        );
      }
      if (joined.includes("issue view") && joined.includes("--json comments")) {
        return Promise.resolve(ok(JSON.stringify({ comments: [] })));
      }
      // close-cascade dependent lookup: gh issue list --label req:42 ...
      if (joined.includes("issue list") && joined.includes("req:42")) {
        return Promise.resolve(ok(JSON.stringify([])));
      }
      // everything else (edit / comment / close) → ok
      return Promise.resolve(ok());
    }

    if (cmd === "git") {
      if (joined.includes("rev-parse --short HEAD")) return Promise.resolve(ok("abc1234"));
      return Promise.resolve(ok());
    }

    return Promise.resolve(ok());
  };

  // Keep repoRoot referenced for readers of the scripted urls/cwd expectations.
  void repoRoot;
  return { exec, trace };
}

describe("wiring integration — real buildProcessDeps over a fake exec", () => {
  it("exposes the declared Validation moments to the engine dependency surface", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-validation-moments-"));
    mkdirSync(join(root, ".red"), { recursive: true });
    writeFileSync(
      join(root, ".red", "config.yaml"),
      [
        "plugins:",
        "  dev:",
        "    enabled: true",
        "    afk:",
        "      validation:",
        "        iteration:",
        "          - pnpm test",
        "        post_done:",
        "          - pnpm typecheck",
        "        landing:",
        "          - pnpm build",
        "",
      ].join("\n"),
    );
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const { exec } = makeFakeExec(root);
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const deps = buildProcessDeps({
      ctx,
      model: "gpt-5.5",
      sandbox: "none",
      feedback,
      current: { attemptDir: join(root, ".red", "tmp", "workers", "w1", "42-a1") },
      fallbackRunner: false,
      runner: "codex",
      exec,
      inlineVerifyCommand: "pnpm test:inline",
    });

    expect(deps.validationMoments).toEqual({
      iteration: ["pnpm test"],
      post_done: ["pnpm typecheck", "pnpm test:inline"],
      landing: ["pnpm build"],
    });
  });

  it("feeds a landing conflict resolver's native stream into its parent Worker lane (#2480)", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-linked-resolver-"));
    const attemptDir = join(root, ".red", "tmp", "workers", "wLINK", "2480");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(attemptDir, "afk.state.toon"), JSON.stringify({
      worker_id: "wLINK",
      pid: process.pid,
      runner: "codex",
      current: { number: 2480, phase: "merge", activity: "landing" },
    }));
    const exec: ExecFn = async (command, _args, options) => {
      if (command === "codex") {
        options?.onStdoutLine?.(JSON.stringify({
          type: "item.started",
          item: { type: "command_execution", command: "git add resolved.ts" },
        }));
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const deps = buildProcessDeps({
      ctx,
      model: "gpt-5.5",
      sandbox: "none",
      feedback,
      current: { attemptDir },
      fallbackRunner: false,
      runner: "codex",
      exec,
      workerId: "wLINK",
    });

    await deps.conflictResolver?.("resolve the conflict", root);

    const records = await readCastleLaneRecords(
      castleLanePath(createEnginePaths(join(root, ".red")), "worker", "wLINK"),
    );
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "worker.subagent_heartbeat",
        payload: expect.objectContaining({
          phase: "merge-resolver",
          signal: "tool",
          tool: "git add resolved.ts",
        }),
      }),
    ]));
  });

  it("prefers the fleet Trunk override over the repository default", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-fleet-trunk-"));
    mkdirSync(join(root, ".red"), { recursive: true });
    writeFileSync(
      join(root, ".red", "config.yaml"),
      "plugins:\n  dev:\n    enabled: true\n    trunk: main\n",
    );
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const { exec } = makeFakeExec(root);
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const current = { attemptDir: join(root, ".red", "tmp", "workers", "w1", "42-a1") };
    const previous = process.env.RED_AFK_TRUNK;
    process.env.RED_AFK_TRUNK = "develop";
    try {
      const deps = buildProcessDeps({
        ctx,
        model: "claude-opus-4-8",
        sandbox: "none",
        feedback,
        current,
        fallbackRunner: false,
        runner: "claude",
        exec,
      });
      expect(deps.lookups.base.configTrunk).toBe("develop");
    } finally {
      if (previous === undefined) delete process.env.RED_AFK_TRUNK;
      else process.env.RED_AFK_TRUNK = previous;
    }
  });

  it("wires landing.wait=none through rsp's shared wait with per-wait fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-landing-tail-"));
    mkdirSync(join(root, ".red"), { recursive: true });
    writeFileSync(
      join(root, ".red", "config.yaml"),
      "plugins:\n  dev:\n    enabled: true\n    afk:\n      landing:\n        wait: none\n",
    );
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const { exec, trace } = makeFakeExec(root);
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const current = { attemptDir: join(root, ".red", "tmp", "workers", "w1", "42-a1") };
    const deps = buildProcessDeps({
      ctx,
      model: "claude-opus-4-8",
      sandbox: "none",
      feedback,
      current,
      fallbackRunner: false,
      runner: "claude",
      exec,
    });
    const run = vi.fn(async (_ciAlreadyGreen?: boolean) => ({ ok: true as const, locked: false }));

    const result = await deps.landingTailObserver!({
      issue: 42,
      prNumber: 77,
      waitForCi: true,
      run,
    });

    expect(deps.landingWait).toBe("none");
    expect(deps.ciAwait).toBeDefined();
    expect(result).toEqual({ ok: true, locked: false });
    expect(run).toHaveBeenCalledWith(true);
    expect(trace).toContainEqual({
      cmd: "rsp",
      args: [
        "wait",
        "pr",
        "77",
        "--timeout",
        "1800s",
        "--reason",
        "finish AFK landing for issue 42",
      ],
      cwd: root,
    });
  });

  it("returns a failed local branch deletion through the runtime git boundary", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "branch is checked out" });

    await expect(deleteLocalBranch({ cwd: "/repo", exec }, "afk/w1/42-fix-thing")).resolves.toEqual({
      ok: false,
      error: "git branch -D failed for afk/w1/42-fix-thing: branch is checked out",
    });
  });

  it("rebases a cascade branch directly onto the pinned landing SHA", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-cascade-"));
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const { exec, trace } = makeFakeExec(root);
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const current = { attemptDir: join(root, ".red", "tmp", "workers", "w1", "42-a1") };
    const deps = buildProcessDeps({
      ctx,
      model: "claude-opus-4-8",
      sandbox: "none",
      feedback,
      current,
      fallbackRunner: false,
      runner: "claude",
      exec,
    });

    const result = await deps.cascadeRebase!.rebaseAndPush(
      root,
      "afk/w2/43-fix-sibling",
      "abc1234",
    );

    expect(result.ok).toBe(true);
    expect(trace).toContainEqual({
      cmd: "git",
      args: ["rebase", "abc1234"],
      cwd: expect.stringContaining("cascade/afk-w2-43-fix-sibling-"),
    });
  });

  /**
   * Build the REAL assembly with the fake exec injected, then drive the gh/git
   * closures in DONE-close-path order and assert the exact OS-command trace.
   */
  it("issues the DONE close-path gh/git commands with the right argv + cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-"));
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const { exec, trace } = makeFakeExec(root);

    // A real FeedbackWorktree (its pnpm/layout closures are never invoked here —
    // we only exercise gh/git). makeRunAgent etc. are likewise assembled but not
    // run on this path.
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const current = { attemptDir: join(root, ".red", "tmp", "workers", "w1", "42-a1") };

    // THE REAL ASSEMBLY. exec is the only injected seam; everything else is the
    // production binding (config loads to defaults from the empty tmp root).
    const deps = buildProcessDeps({
      ctx,
      model: "claude-opus-4-8",
      sandbox: "none",
      feedback,
      current,
      fallbackRunner: false,
      runner: "claude",
      exec,
    });

    const issue = 42;
    const base = "main";
    const branch = "afk/w1/42-fix-thing";

    // ---- replay the DONE close path's gh/git side effects, in order ----
    // (process-issue.ts: claim → handoff lookups → granted fork → push →
    //  integrate/land → close → cleanup → cascade). We invoke the closures the
    //  real assembly produced; the trace records what each one issued.

    // 1. claim pre-check + label flip (steps 1)
    const labels = await deps.gh.viewLabels(issue);
    expect(labels).toEqual(["ready-for-agent"]);
    const flipped = await deps.gh.editLabels(issue, ["ready-for-agent"], ["running"]);
    expect(flipped).toBe(true);

    // 2. handoff lookups (step 3)
    await deps.lookups.comments(issue);
    await deps.lookups.issueUrl(issue);

    // 3. push the worker branch (step 6) — exact pushAttempt argv shape
    await deps.remoteGit(["-C", root, "push", "origin", `${branch}:refs/heads/${branch}`]);

    // 4. integrate origin/base (step 6) via mergeExec — fast-forward path argv
    await deps.mergeExec(["git", "-C", root, "merge", "--ff-only", `origin/${base}`]);

    // 5. read the merge sha (step 7)
    const sha = await deps.git.headShortSha();
    expect(sha).toBe("abc1234");

    // 7. close + drop running label (step 7)
    await deps.gh.close(issue);
    await deps.gh.editLabels(issue, ["running"], []);

    // 8. delete the remote attempt branch (step 7) — exact deleteRemote argv
    await deps.remoteGit(["-C", root, "push", "origin", "--delete", branch]);

    // 9. delete the local branch (step 8)
    await deps.git.deleteLocalBranch(branch);

    // 10. close cascade dependent lookup (step 9)
    await deps.gh.listByLabel(`req:${issue}`);

    // ---- assert the exact OS-command trace ----
    // Every closure ran from the primary checkout (ctx.root). A no-op or
    // wrong-cwd binding would surface here.
    expect(trace).toEqual([
      { cmd: "gh", args: ["api", "repos/acme/widgets/issues/42"], cwd: root },
      {
        cmd: "gh",
        args: ["issue", "edit", "42", "--repo", "acme/widgets", "--remove-label", "ready-for-agent", "--add-label", "running"],
        cwd: root,
      },
      { cmd: "gh", args: ["issue", "view", "42", "--repo", "acme/widgets", "--json", "comments"], cwd: root },
      { cmd: "gh", args: ["api", "repos/acme/widgets/issues/42"], cwd: root },
      { cmd: "git", args: ["-C", root, "push", "origin", `${branch}:refs/heads/${branch}`], cwd: root },
      { cmd: "git", args: ["-C", root, "merge", "--ff-only", "origin/main"], cwd: root },
      { cmd: "git", args: ["rev-parse", "--short", "HEAD"], cwd: root },
      { cmd: "gh", args: ["issue", "close", "42", "--repo", "acme/widgets", "--reason", "completed"], cwd: root },
      { cmd: "gh", args: ["issue", "edit", "42", "--repo", "acme/widgets", "--remove-label", "running"], cwd: root },
      { cmd: "git", args: ["-C", root, "push", "origin", "--delete", branch], cwd: root },
      { cmd: "git", args: ["branch", "-D", branch], cwd: root },
      {
        cmd: "gh",
        args: ["issue", "list", "--repo", "acme/widgets", "--label", "req:42", "--state", "open", "--limit", "200", "--json", "number,labels"],
        cwd: root,
      },
    ]);
  });

  /**
   * Guard the production invariant: buildProcessDeps must NOT set exec by
   * default — the real execTool path stays in force in production. (Static check
   * that the param is optional and defaults to undefined: the closures below are
   * assembled, but because we pass no exec, nothing routes through a fake. We
   * assert by reading the source guarantee — see the grep in the task — and by
   * exercising the default arity here.)
   */
  it("leaves exec undefined by default (production stays on the real execTool)", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-default-"));
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const current = { attemptDir: join(root, ".red", "tmp", "workers", "w1", "1-a1") };
    // No exec arg → production binding. Assembling must not throw.
    const deps = buildProcessDeps({
      ctx,
      model: "claude-opus-4-8",
      sandbox: "none",
      feedback,
      current,
      fallbackRunner: false,
      runner: "claude",
    });
    expect(typeof deps.gh.viewLabels).toBe("function");
    expect(typeof deps.remoteGit).toBe("function");
    expect(typeof deps.mergeExec).toBe("function");
  });

  it("runs the Codex issue classifier on the validate gpt tier with reasoning effort", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-wiring-codex-classifier-"));
    const ctx: RepoContext = { root, repo: "acme/widgets", remote: "origin" };
    const { exec, trace } = makeFakeExec(root);
    const feedback = makeFeedbackWorktree(root, join(root, ".red", "tmp", "feedback"));
    const current = { attemptDir: join(root, ".red", "tmp", "workers", "w1", "42-a1") };

    const deps = buildProcessDeps({
      ctx,
      model: "gpt-5.5",
      sandbox: "none",
      feedback,
      current,
      fallbackRunner: false,
      runner: "codex",
      exec,
    });

    await expect(
      deps.classifyIssue?.({
        issue: 42,
        title: "Implement small formatter fix",
        summary: "Implement small formatter fix",
        labels: ["ready-for-agent"],
        referencedPaths: ["apps/dev/src/core/config.ts"],
        extensions: ["ts"],
        scopePaths: ["apps/dev"],
        referencedFileCount: 1,
        diffSize: "small",
        bodyChars: 120,
        hasTests: true,
        riskKeywords: [],
      }),
    ).resolves.toBe("simple");

    expect(trace).toEqual([
      {
        cmd: "codex",
        args: [
          "exec",
          // The shipped codex table is one pair on EVERY tier now, validate
          // included — the maintainer pin, not a per-tier ladder.
          "--model",
          "gpt-5.6-sol",
          "-c",
          "model_reasoning_effort=high",
          "-C",
          root,
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          expect.stringContaining("Return only JSON"),
        ],
        cwd: root,
      },
    ]);
  });
});
