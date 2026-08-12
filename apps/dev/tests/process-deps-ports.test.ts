import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildClaimGhPort, buildGhPort, buildReviewPorts } from "../src/commands/run/ports/gh.js";
import { buildGitPorts } from "../src/commands/run/ports/git.js";
import { buildFsPort } from "../src/commands/run/ports/fs.js";
import { buildHooks } from "../src/commands/run/ports/hooks.js";
import { buildEnvelopePort } from "../src/commands/run/ports/envelope.js";
import { buildLookups } from "../src/commands/run/ports/lookups.js";
import { afkPaths } from "../src/runtime/wire.js";
import { loadConfig } from "../src/core/config.js";
import { makeHookResolveOptions } from "../src/runtime/hooks.js";
import type { GhContext } from "../src/runtime/gh.js";
import type { GitContext } from "../src/runtime/git.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import { restIssueBody } from "./support/gh-rest-fixtures.js";

/**
 * Per-context port-builder units (#2667). `buildProcessDeps` used to assemble
 * every port inline from 13 positional params, so a mis-bound closure was only
 * caught — if at all — by the whole-assembly wiring test. Each builder now takes
 * ONE context, and each is driven here over a fake context: a recording fake
 * exec for the gh/git surfaces, a tmpdir-rooted path set for the fs surfaces.
 * The command trace is the assertion: a wrong-cwd or no-op closure makes it wrong.
 */

interface TraceEntry {
  cmd: string;
  args: string[];
  cwd: string | undefined;
}

function makeFakeExec(reply: (cmd: string, joined: string) => string = () => ""): {
  exec: ExecFn;
  trace: TraceEntry[];
} {
  const trace: TraceEntry[] = [];
  const exec: ExecFn = (cmd, args, opts) => {
    trace.push({ cmd, args: [...args], cwd: opts?.cwd });
    const out: ExecOutput = { code: 0, stdout: reply(cmd, args.join(" ")), stderr: "" };
    return Promise.resolve(out);
  };
  return { exec, trace };
}

function ghContext(exec: ExecFn, root = "/repo"): GhContext {
  return { cwd: root, repo: "acme/widgets", exec };
}

function gitContext(exec: ExecFn, root = "/repo"): GitContext {
  return { cwd: root, exec };
}

describe("buildGhPort", () => {
  it("binds every issue closure to the one gh context", async () => {
    // The label read is a single-object read, so it routes to REST (#3094).
    const { exec, trace } = makeFakeExec((_cmd, joined) =>
      /\bapi repos\/[^ ]+\/issues\/\d+$/.test(joined)
        ? JSON.stringify(restIssueBody({ labels: ["running"] }))
        : "",
    );
    const gh = buildGhPort(ghContext(exec));

    expect(await gh.viewLabels(42)).toEqual(["running"]);
    await gh.comment(42, "hello");
    await gh.close(42);

    expect(trace.every((entry) => entry.cmd === "gh" && entry.cwd === "/repo")).toBe(true);
    expect(trace.every((entry) => entry.args.join(" ").includes("acme/widgets"))).toBe(true);
  });

  it("swallows an ensureLabel failure so a missing typed label never fails the close", async () => {
    const gh = buildGhPort(ghContext(() => Promise.reject(new Error("gh down"))));
    await expect(gh.ensureLabel("type:bug")).resolves.toBeUndefined();
  });
});

describe("buildClaimGhPort", () => {
  it("posts claims through the same gh context", async () => {
    const { exec, trace } = makeFakeExec(() => "1234567");
    const claimGh = buildClaimGhPort(ghContext(exec));

    await claimGh.postClaim(42, "claiming");

    expect(trace[0]?.cmd).toBe("gh");
    expect(trace[0]?.cwd).toBe("/repo");
  });

  it("swallows concede and audit failures — both are best-effort", async () => {
    const claimGh = buildClaimGhPort(ghContext(() => Promise.reject(new Error("gh down"))));
    await expect(
      (async () => {
        await claimGh.concede(42, "conceding");
        await claimGh.audit?.(42, "recovered");
      })(),
    ).resolves.toBeUndefined();
  });
});

describe("buildReviewPorts", () => {
  it("posts the backpressure evidence as a COMMENT review on the PR", async () => {
    const { exec, trace } = makeFakeExec();
    const { postBackpressureReview } = buildReviewPorts(ghContext(exec));

    await postBackpressureReview(99, "backpressure ledger");

    const issued = trace.map((entry) => entry.args.join(" ")).join(" | ");
    expect(issued).toContain("99");
    expect(trace.every((entry) => entry.cwd === "/repo")).toBe(true);
  });
});

describe("buildGitPorts", () => {
  it("binds mergeExec and remoteGit to the same git context", async () => {
    const { exec, trace } = makeFakeExec();
    const { mergeExec, remoteGit } = buildGitPorts(gitContext(exec, "/checkout"), "origin");

    await remoteGit(["rev-parse", "HEAD"]);
    await mergeExec(["status"]);

    expect(trace.map((entry) => entry.cwd)).toEqual(["/checkout", "/checkout"]);
  });
});

describe("buildFsPort", () => {
  it("sweeps completed attempts under the workers root it was built with", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-fs-"));
    const paths = afkPaths(root);
    const attemptDir = join(paths.workersRoot, "wPORT", "2667-a1");
    mkdirSync(attemptDir, { recursive: true });
    const fs = buildFsPort(paths);

    await fs.writeHandoff(join(attemptDir, "handoff.md"), "handoff body");
    expect(await fs.readText?.(join(attemptDir, "handoff.md"))).toBe("handoff body");

    expect(await fs.completionSweep(2667)).toEqual([attemptDir]);
    expect(await fs.readText?.(join(attemptDir, "handoff.md"))).toBeNull();
  });
});

describe("buildHooks", () => {
  it("carries the config through and stamps the repo anchor into the hook env", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-hooks-"));
    const config = loadConfig(join(root, ".red", "config.yaml"), { warn: () => undefined });

    const hooks = buildHooks({ config, root, repo: "acme/widgets", runner: "claude", slot: 3 });

    expect(hooks.config).toBe(config);
    expect(hooks.env).toMatchObject({
      RED_AFK_REPO: "acme/widgets",
      RED_AFK_ROOT: root,
      RED_AFK_RUNNER: "claude",
      RED_AFK_SLOT: "3",
    });
  });

  it("honours injected resolve options and omits the slot when unslotted", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-hooks-opts-"));
    const config = loadConfig(join(root, ".red", "config.yaml"), { warn: () => undefined });
    const resolveOptions = makeHookResolveOptions(root);

    const hooks = buildHooks({ config, root, repo: "acme/widgets", runner: "codex", resolveOptions });

    expect(hooks.resolveOptions).toBe(resolveOptions);
    expect(hooks.env?.RED_AFK_SLOT).toBeUndefined();
  });
});

describe("buildEnvelopePort", () => {
  it("writes its markers into the CURRENT attempt dir and posts through gh", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-envelope-"));
    const first = join(root, "attempt-1");
    const current = { attemptDir: first };
    const { exec, trace } = makeFakeExec();
    const envelope = buildEnvelopePort(ghContext(exec, root), gitContext(exec, root), current);

    expect(await envelope.poster(42, "envelope body")).toBe(true);
    expect(trace[0]?.cmd).toBe("gh");

    await envelope.writeMarkers({ failureReason: "stalled\n" });
    expect(readFileSync(join(first, "failure.reason"), "utf8")).toBe("stalled\n");

    // The port reads the attempt dir per call, so buildProcessInput can move it
    // between issues without rebuilding the deps.
    const second = join(root, "attempt-2");
    current.attemptDir = second;
    await envelope.writeMarkers({ failureReason: "next\n" });
    expect(readFileSync(join(second, "failure.reason"), "utf8")).toBe("next\n");
  });
});

describe("buildLookups", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the base from config and probes branches through the git context", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-lookups-"));
    mkdirSync(join(root, ".red"), { recursive: true });
    const configPath = join(root, ".red", "config.yaml");
    writeFileSync(
      configPath,
      "plugins:\n  dev:\n    enabled: true\n    trunk: trunk-branch\n",
      "utf8",
    );
    const config = loadConfig(configPath, { warn: () => undefined });
    const { exec, trace } = makeFakeExec();
    // RED_AFK_TRUNK outranks the configured trunk, so pin it empty to read the
    // config path this case is about; the override itself is pinned below.
    vi.stubEnv("RED_AFK_TRUNK", "");

    const lookups = buildLookups({
      ghCtx: ghContext(exec, root),
      gitCtx: gitContext(exec, root),
      paths: afkPaths(root),
      config,
      exec,
    });

    expect(lookups.base.configTrunk).toBe("trunk-branch");
    expect(await lookups.isLocked()).toBe(false);


    await lookups.changedFiles("afk/2667", "main");
    expect(trace.at(-1)?.cwd).toBe(root);
  });

  it("censuses open PRs through the gh slug and drops malformed rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-lookups-prs-"));
    const rows = JSON.stringify([
      { number: 12, headRefName: "afk/2667", body: "Refs #2667" },
      { number: 0, headRefName: "afk/broken" },
      { number: 13, headRefName: "" },
    ]);
    const { exec, trace } = makeFakeExec((cmd) => (cmd === "gh" ? rows : ""));

    const lookups = buildLookups({
      ghCtx: ghContext(exec, root),
      gitCtx: gitContext(exec, root),
      paths: afkPaths(root),
      config: loadConfig(join(root, ".red", "config.yaml"), { warn: () => undefined }),
      exec,
    });

    expect(await lookups.discoverOpenPullRequests?.(2667)).toEqual([
      { number: 12, headRefName: "afk/2667", body: "Refs #2667" },
    ]);
    // Reads now route through the REST planner (#3734), which embeds the
    // slug in the api path rather than passing a standalone --repo arg.
    expect(trace.at(-1)?.args).toContain("repos/acme/widgets/pulls");
  });

  it("returns an empty census when the gh probe fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "afk-ports-lookups-fail-"));
    const exec: ExecFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" });

    const lookups = buildLookups({
      ghCtx: ghContext(exec, root),
      gitCtx: gitContext(exec, root),
      paths: afkPaths(root),
      config: loadConfig(join(root, ".red", "config.yaml"), { warn: () => undefined }),
      exec,
    });

    expect(await lookups.discoverOpenPullRequests?.(2667)).toEqual([]);
  });
});
