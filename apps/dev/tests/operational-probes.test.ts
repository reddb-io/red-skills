import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decode } from "@reddb-io/toon";
import { statusFileName } from "@reddb-io/shared/self-update.js";
import { parseCurrentBlocker } from "../src/core/blocker-state.js";
import { readDevBundleCacheState } from "../src/core/bundle-version.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";
import {
  applyOperationalProbeFixes,
  classifyQueueVisibilityTransportFailure,
  renderOperationalProbeReportToon,
  runOperationalProbes,
} from "../src/core/operational-probes.js";
import { fastForwardLocalTarget, type Exec, type ExecResult } from "../src/core/merge.js";
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
      { id: "afk.host-prerequisites", name: "AFK host prerequisites", verdict: "ok" },
      { id: "git.remote.https-forbidden", name: "SSH-only git remotes", verdict: "red" },
      { id: "afk.queue-visibility", name: "AFK queue visibility", verdict: "ok" },
      { id: "afk.focal-branch-resolution", name: "AFK focal branch resolution", verdict: "ok" },
      { id: "afk.base-freshness", name: "AFK local trunk freshness", verdict: "ok" },
      { id: "afk.fleet-truth", name: "AFK fleet truth", verdict: "ok" },
      { id: "afk.bundle-coherence", name: "AFK bundle coherence", verdict: "ok" },
      { id: "afk.claim-hygiene", name: "AFK claim hygiene", verdict: "ok" },
      { id: "afk.label-body-coherence", name: "AFK label/body coherence", verdict: "ok" },
      { id: "config.coherence", name: "Config coherence", verdict: "ok" },
    ]);
    expect(decoded.findings).toHaveLength(1);
    expect(toon).not.toContain("{\n");
    expect(toon).not.toContain('": "');
  });

  it("reports pointer/lane/npm bundle skew with canonical fix guidance", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      bundleCoherence: {
        installedVersion: "2.63.0",
        pointerVersion: "2.63.0",
        laneNewestVersion: "2.64.0",
        npmNewestVersion: "2.64.1",
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "afk.bundle-coherence",
        name: "AFK bundle coherence",
        verdict: "red",
        evidence: expect.stringContaining("findings=pointer-behind-lane,pointer-behind-npm,lane-behind-npm"),
        canonicalFix: expect.stringContaining("reconcile the stable pointer"),
      }),
    ]);
  });

  it("self-heals a pointer behind a cached lane but halts when the pointer is ahead of every lane", async () => {
    const selfHealable = await runOperationalProbes({
      remoteUrls: [],
      bundleCoherence: {
        installedVersion: "2.79.1",
        pointerVersion: "2.79.0",
        laneNewestVersion: "2.80.0",
      },
    });
    const incoherent = await runOperationalProbes({
      remoteUrls: [],
      bundleCoherence: {
        installedVersion: "2.79.1",
        pointerVersion: "2.80.0",
      },
    });

    expect(selfHealable.findings).toEqual([]);
    expect(selfHealable.probes.find((probe) => probe.id === "afk.bundle-coherence")).toMatchObject({
      verdict: "ok",
      data: { findings: ["pointer-behind-lane"], selfHealable: ["pointer-behind-lane"] },
    });
    expect(incoherent.findings).toEqual([
      expect.objectContaining({
        id: "afk.bundle-coherence",
        verdict: "red",
        evidence: expect.stringContaining("pointer-ahead-of-lane"),
        canonicalFix: expect.stringContaining("cached lane"),
      }),
    ]);
  });

  it("reports stale failed bundle checks even without npm truth", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      bundleCoherence: {
        installedVersion: "2.63.0",
        pointerVersion: "2.63.0",
        laneNewestVersion: "2.63.0",
        npmError: "fetch failed",
        lastFailureAgeMs: 5 * 60 * 60 * 1000,
        lastError: "fetch failed",
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "afk.bundle-coherence",
        verdict: "red",
        evidence: expect.stringContaining("stale-failed-check"),
      }),
    ]);
  });

  it("reports a stale successful bundle check with the verdict age", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      bundleCoherence: {
        installedVersion: "3.3.19",
        pointerVersion: "3.3.19",
        laneNewestVersion: "3.3.19",
        npmNewestVersion: "3.3.21",
        lastStatus: "up-to-date",
        lastCheckAgeMs: 5 * 60 * 60 * 1000,
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "afk.bundle-coherence",
        verdict: "red",
        evidence: expect.stringContaining("last_check=up-to-date@5h"),
        data: expect.objectContaining({
          findings: expect.arrayContaining(["stale-successful-check"]),
        }),
      }),
    ]);
    expect(report.findings[0]?.evidence).toContain("versions_since_check=2");
  });

  it("stays ok when the last self-update success supersedes an old failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-bundle-cache-"));
    try {
      await writeFile(
        join(root, statusFileName("dev")),
        encodeDevSnapshotToon({
          lastCheckAtMs: 100_000_000,
          lastSuccessAtMs: 100_000_000,
          lastFailureAtMs: 100_000_000 - 91 * 60 * 60 * 1000,
          lastStatus: "up-to-date",
        }),
        "utf8",
      );

      const report = await runOperationalProbes({
        remoteUrls: [],
        bundleCoherence: {
          ...readDevBundleCacheState("2.87.3", { RED_SKILLS_CACHE_DIR: root }, 100_000_000),
          pointerVersion: "2.87.3",
        },
      });

      expect(report.findings).toEqual([]);
      expect(report.probes.find((probe) => probe.id === "afk.bundle-coherence")).toMatchObject({
        verdict: "ok",
        data: { findings: [] },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces malformed config fallback with the offending line and construct", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      configCoherence: {
        path: "/repo/.red/config.yaml",
        displayPath: ".red/config.yaml",
        fileLoaded: true,
        discarded: true,
        parseFailure: {
          message: "malformed YAML at line 3: unsupported folded block scalar",
          line: 3,
          construct: "unsupported folded block scalar",
        },
        rootAccessorCollisions: [],
        resolved: { trunk: "main", gate: "", lock: "" },
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "config.coherence",
        name: "Config coherence",
        verdict: "red",
        evidence: expect.stringContaining("line 3: unsupported folded block scalar"),
        canonicalFix: expect.stringContaining("boot must not continue on default trunk"),
      }),
    ]);
  });

  it("surfaces root-level accessor spellings with canonical relocation and diff preview fix", async () => {
    const sourceText = "dev:\n  trunk: develop\nafk:\n  default_runner: codex\n";
    const report = await runOperationalProbes({
      remoteUrls: [],
      configCoherence: {
        path: "/repo/.red/config.yaml",
        displayPath: ".red/config.yaml",
        fileLoaded: true,
        discarded: false,
        rootAccessorCollisions: [
          { key: "afk.default_runner", canonicalKey: "plugins.dev.afk.default_runner" },
          { key: "dev.trunk", canonicalKey: "plugins.dev.trunk" },
        ],
        resolved: { trunk: "develop", gate: "", lock: "" },
        sourceText,
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "config.coherence",
        verdict: "red",
        evidence: expect.stringContaining("canonical relocation plugins.dev.afk.default_runner, plugins.dev.trunk"),
        canonicalFix: expect.stringContaining("Relocate afk.default_runner, dev.trunk"),
        fix: { gate: "confirm", description: "Preview and apply canonical config relocation." },
      }),
    ]);

    const preview = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    const fixes = await applyOperationalProbeFixes(report, {
      readText: async () => sourceText,
      showDiffPreview: preview,
      confirm: async () => false,
      writeText,
    });

    expect(preview).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("+plugins:"));
    expect(fixes).toEqual([{ probeId: "config.coherence", status: "declined", evidence: "operator declined fix" }]);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("applies the confirmed config relocation without changing unrelated lines", async () => {
    const sourceText = "# keep\n\ndev:\n  trunk: develop\nnotes:\n  owner: team\n";
    const report = await runOperationalProbes({
      remoteUrls: [],
      configCoherence: {
        path: "/repo/.red/config.yaml",
        displayPath: ".red/config.yaml",
        fileLoaded: true,
        discarded: false,
        rootAccessorCollisions: [{ key: "dev.trunk", canonicalKey: "plugins.dev.trunk" }],
        resolved: { trunk: "develop", gate: "", lock: "" },
        sourceText,
      },
    });
    const writes: string[] = [];

    const fixes = await applyOperationalProbeFixes(report, {
      readText: async () => sourceText,
      showDiffPreview: async () => {},
      confirm: async () => true,
      writeText: async (_path, text) => {
        writes.push(text);
      },
    });

    expect(fixes).toEqual([
      { probeId: "config.coherence", status: "applied", evidence: "relocated root-level config under plugins.dev" },
    ]);
    expect(writes[0]).toBe("# keep\n\nnotes:\n  owner: team\n\nplugins:\n  dev:\n    trunk: develop\n");
  });

  it("reports healthy canonical config values as green", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      configCoherence: {
        path: "/repo/.red/config.yaml",
        displayPath: ".red/config.yaml",
        fileLoaded: true,
        discarded: false,
        rootAccessorCollisions: [],
        resolved: { trunk: "develop", gate: "true", lock: "release" },
      },
    });

    expect(report.findings).toEqual([]);
    expect(report.probes.find((probe) => probe.id === "config.coherence")?.evidence).toContain(
      "resolved trunk=develop gate=true lock=release; every canonical key resolved",
    );
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

  it("re-samples a transient queue mismatch and records its recovery as info", async () => {
    const listEngineCandidates = vi.fn()
      .mockResolvedValueOnce([2448])
      .mockResolvedValueOnce([2448, 2449]);
    const listRestQueue = vi.fn().mockResolvedValue([2448, 2449]);

    const report = await runOperationalProbes({
      remoteUrls: [],
      queueVisibility: {
        listEngineCandidates,
        listRestQueue,
        resampleDelayMs: 0,
      },
    });

    expect(listEngineCandidates).toHaveBeenCalledTimes(2);
    expect(listRestQueue).toHaveBeenCalledTimes(2);
    expect(report.findings).toEqual([]);
    expect(report.probes.find((probe) => probe.id === "afk.queue-visibility")).toMatchObject({
      verdict: "ok",
      evidence: "info: transient queue mismatch cleared on re-sample; first differing issues: #2449",
    });
  });

  it("flags a persistent engine-vs-REST queue mismatch with differing issue numbers", async () => {
    const listEngineCandidates = vi.fn(async () => []);
    const listRestQueue = vi.fn(async () => [11, 12, 13]);

    const report = await runOperationalProbes({
      remoteUrls: [],
      queueVisibility: {
        listEngineCandidates,
        listRestQueue,
        resampleDelayMs: 0,
      },
    });

    expect(listEngineCandidates).toHaveBeenCalledTimes(2);
    expect(listRestQueue).toHaveBeenCalledTimes(2);
    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "afk.queue-visibility",
        verdict: "red",
        evidence: "engine sees 0 open ready-for-agent; REST sees 3; differing issues: #11, #12, #13",
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
        listRestQueue: async () => [1],
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
        listEngineCandidates: async () => [1],
        listRestQueue: async () => {
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
        listRestQueue: async () => [],
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

  it("reports a behind-origin local trunk with distance and the shared guard verdict", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      const facts = await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" });
      const report = await runOperationalProbes(facts);

      const finding = report.findings.find((row) => row.id === "afk.base-freshness");
      expect(finding).toMatchObject({
        id: "afk.base-freshness",
        verdict: "red",
        fix: { gate: "confirm" },
      });
      expect(finding?.evidence).toContain("local main is 2 commit(s) behind origin/main");
      expect(finding?.evidence).toContain("guard=passed");
      expect(finding?.canonicalFix).toContain("on-trunk, clean tree");
      expect(finding?.canonicalFix).toContain("patch-equivalent to an origin commit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gated-fixes a real behind-origin local trunk by reusing the finalizer fast-forward guard", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes).toContainEqual({
        probeId: "afk.base-freshness",
        status: "applied",
        evidence: "fast-forwarded main to origin/main",
      });
      expect(git(repo, "rev-parse", "main").trim()).toBe(git(repo, "rev-parse", "origin/main").trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the gated base-freshness fix when the primary is not on trunk", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      git(repo, "checkout", "-b", "feature/work");
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes).toContainEqual({
        probeId: "afk.base-freshness",
        status: "noop",
        evidence: "guard refused: condition failed: on-trunk (current=feature/work expected=main)",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the gated base-freshness fix when the primary trunk is dirty", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      await writeFile(join(repo, "scratch.txt"), "dirty\n", "utf8");
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes).toContainEqual({
        probeId: "afk.base-freshness",
        status: "noop",
        evidence: "guard refused: condition failed: clean-tree (1 dirty path(s): scratch.txt)",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("applies the base-freshness fix when the only dirt is /red-setup's own output (#3106)", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      // Exactly the state `/red-setup` leaves behind: files it wrote and is
      // forbidden to `git add`. Before #3106 this bricked every fresh repo.
      await mkdir(join(repo, ".red"), { recursive: true });
      await writeFile(join(repo, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n", "utf8");
      await writeFile(join(repo, ".red", ".gitignore"), "tmp/\nstate/\n", "utf8");
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes).toContainEqual({
        probeId: "afk.base-freshness",
        status: "applied",
        evidence: "fast-forwarded main to origin/main",
      });
      expect(git(repo, "rev-parse", "main").trim()).toBe(git(repo, "rev-parse", "origin/main").trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * #3155 — the collision every maturing repo reaches: trunk commits the
   * `.red/.gitignore` that `/red-setup` leaves untracked, so the guard tolerated
   * the dirt, `merge --ff-only` aborted on it, and the probe reported
   * `guard=passed` beside a fix that errored out. Local main then sat behind
   * origin forever and every Worker died at the same probe.
   */
  it("recovers a repo whose trunk now TRACKS the file setup left untracked (#3155)", async () => {
    const { root, repo, origin } = await makeBaseFreshnessRepo();
    try {
      // Trunk grows up: a peer commits the file setup only ever wrote locally.
      const peer = join(root, "peer-gitignore");
      git(root, "clone", origin, "peer-gitignore");
      configureGit(peer);
      await mkdir(join(peer, ".red"), { recursive: true });
      await writeFile(join(peer, ".red", ".gitignore"), "# tracked by trunk\ntmp/\nstate/\n", "utf8");
      git(peer, "add", ".red/.gitignore");
      git(peer, "commit", "-m", "track the setup gitignore");
      git(peer, "push", "origin", "main");
      // The local tree still holds the untracked copy `/red-setup` wrote.
      await writeFile(join(repo, ".red", ".gitignore"), "tmp/\nstate/\n", "utf8");

      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes.find((fix) => fix.probeId === "afk.base-freshness")?.status).toBe("applied");
      expect(git(repo, "rev-parse", "main").trim()).toBe(git(repo, "rev-parse", "origin/main").trim());
      // The tracked copy landed; the local one was preserved, never deleted.
      expect(await readFile(join(repo, ".red", ".gitignore"), "utf8")).toContain("# tracked by trunk");
      expect(
        await readFile(join(repo, ".red", "tmp", "superseded-setup-dirt", ".red", ".gitignore"), "utf8"),
      ).toBe("tmp/\nstate/\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses with the real reason when the operator EDITED a now-tracked setup file (#3155)", async () => {
    const { root, repo, origin } = await makeBaseFreshnessRepo();
    try {
      const peer = join(root, "peer-config");
      git(root, "clone", origin, "peer-config");
      configureGit(peer);
      await writeFile(join(peer, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n    trunk: main\n    n: 2\n", "utf8");
      git(peer, "add", ".red/config.yaml");
      git(peer, "commit", "-m", "change the config upstream");
      git(peer, "push", "origin", "main");
      // Tracked here, and locally edited: real content the fast-forward would eat.
      await writeFile(join(repo, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n    trunk: main\n    n: 9\n", "utf8");

      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const finding = report.findings.find((row) => row.id === "afk.base-freshness");
      // The verdict is refused BEFORE the merge, so no `passed` receipt is minted.
      expect(finding?.evidence).toContain("guard=refused");
      expect(finding?.evidence).toContain(".red/config.yaml");
      expect(finding?.evidence).toContain("local main is 3 commit(s) behind origin/main");
      expect(git(repo, "rev-parse", "main").trim()).not.toBe(git(repo, "rev-parse", "origin/main").trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never leaves a guard=passed evidence line standing beside a fix that could not apply (#3155)", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const finding = report.findings.find((row) => row.id === "afk.base-freshness");
      expect(finding?.evidence).toContain("guard=passed");

      // The tree changed between the probe and the fix — the race the receipt lied about.
      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async () => ({
          action: "noop" as const,
          guard: "refused" as const,
          target: "main",
          remote: "origin",
          evidence: "condition failed: merge (ff-only merge of origin/main failed)",
        }),
      });

      const fix = fixes.find((entry) => entry.probeId === "afk.base-freshness");
      expect(fix?.status).toBe("noop");
      expect(fix?.reconciled?.evidence).toContain("guard=refused");
      expect(fix?.reconciled?.evidence).toContain("ff-only merge of origin/main failed");
      expect(fix?.reconciled?.evidence).not.toContain("guard=passed");
      // The trunk is still named, so the reader is not sent to another subsystem.
      expect(fix?.reconciled?.evidence).toContain("local main is 2 commit(s) behind origin/main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves an already-refused finding exactly as reported — nothing to reconcile", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      git(repo, "checkout", "-b", "feature/work");
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });
      expect(fixes.find((fix) => fix.probeId === "afk.base-freshness")?.reconciled).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses the gated base-freshness fix when local trunk is not an ancestor of origin", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      await writeFile(join(repo, "local.txt"), "local\n", "utf8");
      git(repo, "add", "local.txt");
      git(repo, "commit", "-m", "local only");
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes).toContainEqual({
        probeId: "afk.base-freshness",
        status: "noop",
        evidence: expect.stringMatching(
          /^guard refused: condition failed: superseded-commits \([0-9a-f]{40} not carried by origin\/main\)$/,
        ),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles a clean divergent trunk when origin carries every local patch (#3248)", async () => {
    const { root, repo, localSha, remoteSha } = await makeSupersededCommitRepo();
    try {
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const finding = report.findings.find((row) => row.id === "afk.base-freshness");

      expect(finding?.evidence).toContain("guard=passed");
      expect(finding?.evidence).toContain(`${localSha} -> ${remoteSha}`);

      const fixes = await applyOperationalProbeFixes(report, {
        confirm: async () => true,
        fastForwardLocalBase: async ({ remote, target }) =>
          fastForwardLocalTarget(realExec(), { gitRepo: repo, remote, target }),
      });

      expect(fixes.find((fix) => fix.probeId === "afk.base-freshness")).toMatchObject({
        status: "applied",
        evidence: expect.stringContaining(`${localSha} -> ${remoteSha}`),
      });
      expect(git(repo, "rev-parse", "main").trim()).toBe(git(repo, "rev-parse", "origin/main").trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses divergence and names each local commit whose patch origin lacks (#3248)", async () => {
    const { root, repo } = await makeBaseFreshnessRepo();
    try {
      await writeFile(join(repo, "local-only.txt"), "real local work\n", "utf8");
      git(repo, "add", "local-only.txt");
      git(repo, "commit", "-m", "real local work");
      const localSha = git(repo, "rev-parse", "HEAD").trim();

      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const finding = report.findings.find((row) => row.id === "afk.base-freshness");

      expect(finding?.evidence).toContain("guard=refused");
      expect(finding?.evidence).toContain(localSha);
      expect(finding?.evidence).toContain("not carried by origin/main");
      expect(git(repo, "rev-parse", "main").trim()).toBe(localSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still refuses a dirty tree when every divergent commit is superseded (#3248)", async () => {
    const { root, repo, localSha } = await makeSupersededCommitRepo();
    try {
      const configPath = join(repo, ".red", "config.yaml");
      const dirtyConfig = "plugins:\n  dev:\n    enabled: true\n    trunk: main\n    local: keep\n";
      // Setup-owned dirt is tolerated by an ordinary ff-only update, but a
      // superseded-commit repair uses reset --hard and must therefore refuse it.
      await writeFile(configPath, dirtyConfig, "utf8");
      const report = await runOperationalProbes(await collectPrecheckFacts({ root: repo, repo: "", remote: "origin" }));
      const finding = report.findings.find((row) => row.id === "afk.base-freshness");

      expect(finding?.evidence).toContain("guard=refused");
      expect(finding?.evidence).toContain("clean-tree");
      expect(git(repo, "rev-parse", "main").trim()).toBe(localSha);
      expect(await readFile(configPath, "utf8")).toBe(dirtyConfig);
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
  await writeFile(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n    trunk: develop\n", "utf8");
  return { root, lockPath: join(root, ".red", "state", "branch-lock.yaml") };
}

async function makeBaseFreshnessRepo(): Promise<{ root: string; repo: string; origin: string }> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-base-freshness-"));
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const peer = join(root, "peer");
  await mkdir(repo, { recursive: true });
  git(root, "init", "--bare", "-b", "main", "origin.git");
  git(repo, "init", "-b", "main");
  configureGit(repo);
  await mkdir(join(repo, ".red"), { recursive: true });
  await writeFile(join(repo, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n    trunk: main\n", "utf8");
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8");
  git(repo, "add", ".red/config.yaml", "README.md");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");

  git(root, "clone", origin, peer);
  configureGit(peer);
  await writeFile(join(peer, "remote-one.txt"), "one\n", "utf8");
  git(peer, "add", "remote-one.txt");
  git(peer, "commit", "-m", "remote one");
  await writeFile(join(peer, "remote-two.txt"), "two\n", "utf8");
  git(peer, "add", "remote-two.txt");
  git(peer, "commit", "-m", "remote two");
  git(peer, "push", "origin", "main");
  return { root, repo, origin };
}

async function makeSupersededCommitRepo(): Promise<{
  root: string;
  repo: string;
  localSha: string;
  remoteSha: string;
}> {
  const { root, repo, origin } = await makeBaseFreshnessRepo();
  await writeFile(join(repo, "squashed.txt"), "the same patch\n", "utf8");
  git(repo, "add", "squashed.txt");
  git(repo, "commit", "-m", "local pre-squash commit");
  const localSha = git(repo, "rev-parse", "HEAD").trim();

  const peer = join(root, "squash-peer");
  git(root, "clone", origin, "squash-peer");
  configureGit(peer);
  await writeFile(join(peer, "squashed.txt"), "the same patch\n", "utf8");
  git(peer, "add", "squashed.txt");
  git(peer, "commit", "-m", "squashed landing");
  const remoteSha = git(peer, "rev-parse", "HEAD").trim();
  git(peer, "push", "origin", "main");
  return { root, repo, localSha, remoteSha };
}

function configureGit(cwd: string): void {
  git(cwd, "config", "user.email", "red@example.invalid");
  git(cwd, "config", "user.name", "Red Test");
}

function realExec(): Exec {
  return async (argv, options): Promise<ExecResult> => {
    try {
      const stdout = execFileSync(argv[0] ?? "git", argv.slice(1), {
        encoding: "utf8",
        input: options?.input,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        code: err.status ?? 1,
        stdout: String(err.stdout ?? ""),
        stderr: String(err.stderr ?? ""),
      };
    }
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
