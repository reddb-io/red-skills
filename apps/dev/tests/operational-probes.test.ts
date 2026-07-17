import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decode } from "@reddb-io/toon";
import { parseCurrentBlocker } from "../src/core/blocker-state.js";
import {
  applyOperationalProbeFixes,
  classifyQueueVisibilityTransportFailure,
  renderOperationalProbeReportToon,
  runOperationalProbes,
} from "../src/core/operational-probes.js";
import { collectPrecheckFacts } from "../src/runtime/wire.js";

describe("operational probe registry", () => {
  it("reports the HTTPS remote proof probe as red with a canonical fix", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [{ name: "origin", url: "https://example.invalid/acme/widgets.git" }],
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: "git.remote.https-forbidden",
      name: "SSH-only git remotes",
      verdict: "red",
    });
    expect(report.findings[0]?.canonicalFix).toContain("Use SSH git remotes");
  });

  it("leaves the proof probe green when the Actions lane allows HTTPS remotes", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [{ name: "origin", url: "https://example.invalid/acme/widgets.git" }],
      allowHttpsRemote: true,
    });

    expect(report.findings).toEqual([]);
    expect(report.probes[0]?.verdict).toBe("ok");
  });

  it("renders AI-facing output as TOON", async () => {
    const toon = renderOperationalProbeReportToon(
      await runOperationalProbes({ remoteUrls: ["https://example.invalid/acme/widgets.git"] }),
    );
    const decoded = decode(toon) as { probes: Array<{ id: string; verdict: string }>; findings: unknown[] };

    expect(decoded.probes).toEqual([
      { id: "git.remote.https-forbidden", name: "SSH-only git remotes", verdict: "red" },
      { id: "afk.queue-visibility", name: "AFK queue visibility", verdict: "ok" },
      { id: "afk.focal-branch-resolution", name: "AFK focal branch resolution", verdict: "ok" },
      { id: "afk.fleet-truth", name: "AFK fleet truth", verdict: "ok" },
      { id: "afk.claim-hygiene", name: "AFK claim hygiene", verdict: "ok" },
      { id: "afk.label-body-coherence", name: "AFK label/body coherence", verdict: "ok" },
      { id: "config.dev-root-spelling", name: "Config dev-plugin namespacing", verdict: "ok" },
    ]);
    expect(decoded.findings).toHaveLength(1);
    expect(toon).not.toContain("{\n");
    expect(toon).not.toContain('": "');
  });

  it("surfaces root-level dev.* config spellings with the canonical plugins.dev.* fix", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      configNamespacing: { rootDevKeys: ["dev.trunk"] },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "config.dev-root-spelling",
        name: "Config dev-plugin namespacing",
        verdict: "red",
        evidence: expect.stringContaining("dev.trunk"),
        canonicalFix: expect.stringContaining("plugins.dev.trunk"),
      }),
    ]);
    expect(report.findings[0]?.canonicalFix).toContain("plugins.dev.*");
  });

  it("refuses a gated fix without applying any remote changes", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [{ name: "origin", url: "https://example.invalid/acme/widgets.git" }],
    });
    const setRemoteUrl = vi.fn(async () => {});

    const results = await applyOperationalProbeFixes(report, {
      confirm: async () => false,
      setRemoteUrl,
    });

    expect(results).toEqual([
      { probeId: "git.remote.https-forbidden", status: "declined", evidence: "operator declined fix" },
    ]);
    expect(setRemoteUrl).not.toHaveBeenCalled();
  });

  it("applies a confirmed gated fix as an observable remote rewrite", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [{ name: "origin", url: "https://example.invalid/acme/widgets.git" }],
    });
    const setRemoteUrl = vi.fn(async () => {});

    const results = await applyOperationalProbeFixes(report, {
      confirm: async () => true,
      setRemoteUrl,
    });

    expect(results).toEqual([
      { probeId: "git.remote.https-forbidden", status: "applied", evidence: "rewrote 1 remote" },
    ]);
    expect(setRemoteUrl).toHaveBeenCalledWith("origin", "git@example.invalid:acme/widgets.git");
  });

  it("runs the engine listing seam and flags an engine-vs-REST queue mismatch", async () => {
    const listEngineCandidates = vi.fn(async () => 0);
    const countRestQueue = vi.fn(async () => 11);

    const report = await runOperationalProbes({
      remoteUrls: [],
      queueVisibility: {
        listEngineCandidates,
        countRestQueue,
      },
    });

    expect(listEngineCandidates).toHaveBeenCalledOnce();
    expect(countRestQueue).toHaveBeenCalledOnce();
    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "afk.queue-visibility",
        verdict: "red",
        evidence: "engine sees 0 open ready-for-agent; REST sees 11",
      }),
    ]);
  });

  it("classifies SSO/scope failures from captured GitHub payloads with the exact human fix", async () => {
    const payload = await readFixture("saml-enforcement.txt");
    const report = await runOperationalProbes({
      remoteUrls: [],
      queueVisibility: {
        listEngineCandidates: async () => {
          throw Object.assign(new Error("gh issue list failed"), {
            surface: "graphql",
            stderr: payload,
          });
        },
        countRestQueue: async () => 1,
      },
    });

    expect(classifyQueueVisibilityTransportFailure({ surface: "graphql", stderr: payload })).toBe("sso-or-scope");
    expect(report.findings[0]).toMatchObject({
      id: "afk.queue-visibility",
      evidence: "queue listing failed (sso-or-scope, surface=graphql)",
      canonicalFix: expect.stringContaining("gh auth refresh -h github.com -s repo,read:org,workflow"),
    });
    expect(report.findings[0]?.canonicalFix).toContain("SSO authorization prompt");
  });

  it("classifies rate-limit failures distinctly from generic transport failures", async () => {
    const payload = await readFixture("rate-limit.txt");
    const rateLimited = await runOperationalProbes({
      remoteUrls: [],
      queueVisibility: {
        listEngineCandidates: async () => 1,
        countRestQueue: async () => {
          throw Object.assign(new Error("gh api failed"), {
            surface: "rest",
            stderr: payload,
          });
        },
      },
    });
    const generic = await runOperationalProbes({
      remoteUrls: [],
      queueVisibility: {
        listEngineCandidates: async () => {
          throw Object.assign(new Error("socket hang up"), { surface: "unknown" });
        },
        countRestQueue: async () => 0,
      },
    });

    expect(rateLimited.findings[0]).toMatchObject({
      evidence: "queue listing failed (rate-limit, surface=rest)",
      canonicalFix: expect.stringContaining("rate limit window"),
    });
    expect(generic.findings[0]).toMatchObject({
      evidence: "queue listing failed (generic-transport, surface=unknown)",
      canonicalFix: expect.stringContaining("gh auth status"),
    });
  });

  it("flags ready-labelled issues with an active body blocker and archives the blocker on confirmed repair", async () => {
    const fixture = JSON.parse(await readFixture("ready-body-blocker.json")) as Array<{
      number: number;
      title: string;
      labels: string[];
      body: string;
    }>;
    const report = await runOperationalProbes({
      remoteUrls: [],
      labelBodyCoherence: {
        listOpenReadyIssues: async () => fixture,
      },
    });

    const finding = report.findings.find((row) => row.id === "afk.label-body-coherence");
    expect(finding).toMatchObject({
      id: "afk.label-body-coherence",
      verdict: "red",
      fix: { gate: "confirm" },
    });
    expect(finding?.evidence).toContain("issue=#1971");
    expect(finding?.evidence).toContain("labels=[ready-for-agent,priority:normal]");
    expect(finding?.evidence).toContain("blocker={status=blocked kind=validation ref=#1965");
    expect(finding?.evidence).toContain("summary=\"Gate failed before the manual requeue.\"");
    expect(finding?.evidence).toContain("next=\"Confirm the issue is safe to delegate again.\"");

    const updateIssueBody = vi.fn(async (_issue: number, _body: string) => {});
    const fixes = await applyOperationalProbeFixes(report, {
      confirm: async () => true,
      updateIssueBody,
    });

    expect(fixes).toContainEqual({
      probeId: "afk.label-body-coherence",
      status: "applied",
      evidence: "archived 1 active blocker",
    });
    expect(updateIssueBody).toHaveBeenCalledOnce();
    expect(updateIssueBody.mock.calls[0]?.[0]).toBe(1971);
    const nextBody = String(updateIssueBody.mock.calls[0]?.[1] ?? "");
    expect(parseCurrentBlocker(nextBody)).toBeNull();
    expect(nextBody).toContain("## Current blocker\n\nNone");
    expect(nextBody).toContain("## Resolved blockers");
    expect(nextBody).toContain(
      "- [x] Gate failed before the manual requeue. - ready-for-agent label confirmed; active blocker archived by gated repair.",
    );
  });

  it("leaves the ready issue body byte-identical when the coherence repair is refused", async () => {
    const fixture = JSON.parse(await readFixture("ready-body-blocker.json")) as Array<{
      number: number;
      title: string;
      labels: string[];
      body: string;
    }>;
    const before = fixture[0]!.body;
    const report = await runOperationalProbes({
      remoteUrls: [],
      labelBodyCoherence: {
        listOpenReadyIssues: async () => fixture,
      },
    });
    const updateIssueBody = vi.fn(async (_issue: number, _body: string) => {});

    const fixes = await applyOperationalProbeFixes(report, {
      confirm: async () => false,
      updateIssueBody,
    });

    expect(fixes).toContainEqual({
      probeId: "afk.label-body-coherence",
      status: "declined",
      evidence: "operator declined 1 issue repair",
    });
    expect(updateIssueBody).not.toHaveBeenCalled();
    expect(fixture[0]!.body).toBe(before);
  });

  it("reports resolved focal branch provenance when the runtime supplies the boot resolver triple", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      focalBranch: {
        resolved: { branch: "develop", source: "trunk" },
        configuredTrunk: "develop",
      },
    });

    expect(report.findings).toEqual([]);
    expect(report.probes.find((probe) => probe.id === "afk.focal-branch-resolution")).toMatchObject({
      id: "afk.focal-branch-resolution",
      verdict: "ok",
      evidence: "resolved develop from trunk; configuredTrunk=develop",
    });
  });

  it("flags stale and contradictory branch locks as distinct focal-branch findings", async () => {
    const stale = await runOperationalProbes({
      remoteUrls: [],
      focalBranch: {
        resolved: { branch: "missing/branch", source: "lock" },
        configuredTrunk: "develop",
        lock: {
          raw: "missing/branch\n",
          branch: "missing/branch",
          targetExists: false,
          heldByLiveSession: false,
        },
      },
    });
    const contradictory = await runOperationalProbes({
      remoteUrls: [],
      focalBranch: {
        resolved: { branch: "release/old", source: "lock" },
        configuredTrunk: "develop",
        lock: {
          raw: "release/old\n",
          branch: "release/old",
          targetExists: true,
          heldByLiveSession: false,
        },
      },
    });

    expect(stale.findings[0]).toMatchObject({
      id: "afk.focal-branch-resolution",
      verdict: "red",
      data: expect.objectContaining({ finding: "stale-lock-target-missing" }),
    });
    expect(stale.findings[0]?.evidence).toContain("stale lock target is missing");
    expect(contradictory.findings[0]).toMatchObject({
      id: "afk.focal-branch-resolution",
      verdict: "red",
      data: expect.objectContaining({ finding: "contradictory-lock-without-live-session" }),
    });
    expect(contradictory.findings[0]?.evidence).toContain("without a live holder");
  });

  it("keeps a divergent lock green when the current live session holds it", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      focalBranch: {
        resolved: { branch: "release/held", source: "lock" },
        configuredTrunk: "develop",
        lock: {
          raw: "release/held\n",
          branch: "release/held",
          targetExists: true,
          heldByLiveSession: true,
        },
      },
    });

    expect(report.findings).toEqual([]);
    expect(report.probes.find((probe) => probe.id === "afk.focal-branch-resolution")?.evidence).toContain(
      "resolved release/held from lock",
    );
  });

  it("leaves a real stale branch-lock file byte-identical when the gated repair is refused", async () => {
    const { root, lockPath } = await makeGitRepo();
    try {
      await writeFile(lockPath, "missing/branch\n", "utf8");
      const before = await readFile(lockPath, "utf8");
      const facts = await collectPrecheckFacts({ root, repo: "", remote: "origin" });
      const report = await runOperationalProbes(facts);
      const removeBranchLock = vi.fn(async () => {
        await rm(lockPath, { force: true });
      });

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => false,
        removeBranchLock,
      });

      expect(report.findings[0]).toMatchObject({
        id: "afk.focal-branch-resolution",
        data: expect.objectContaining({ finding: "stale-lock-target-missing" }),
      });
      expect(fixes).toContainEqual({
        probeId: "afk.focal-branch-resolution",
        status: "declined",
        evidence: "operator declined fix",
      });
      expect(removeBranchLock).not.toHaveBeenCalled();
      expect(await readFile(lockPath, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the confirmed gated repair to a real contradictory branch-lock file", async () => {
    const { root, lockPath } = await makeGitRepo();
    try {
      git(root, "checkout", "develop");
      await writeFile(lockPath, "main\n", "utf8");
      const facts = await collectPrecheckFacts({ root, repo: "", remote: "origin" });
      const report = await runOperationalProbes(facts);

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        removeBranchLock: async () => {
          await rm(lockPath, { force: true });
        },
      });

      expect(report.findings[0]).toMatchObject({
        id: "afk.focal-branch-resolution",
        data: expect.objectContaining({ finding: "contradictory-lock-without-live-session" }),
      });
      expect(fixes).toContainEqual({
        probeId: "afk.focal-branch-resolution",
        status: "applied",
        evidence: "cleared branch-lock",
      });
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function readFixture(name: string): Promise<string> {
  return readFile(join(process.cwd(), "tests", "fixtures", "github-transport", name), "utf8");
}

async function makeGitRepo(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-focal-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "red@example.invalid");
  git(root, "config", "user.name", "Red Test");
  await writeFile(join(root, "README.md"), "fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "initial");
  git(root, "branch", "develop");
  await mkdir(join(root, ".red", "state"), { recursive: true });
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    trunk: develop\n", "utf8");
  return { root, lockPath: join(root, ".red", "state", "branch-lock.yaml") };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
