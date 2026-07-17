import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  applyOperationalProbeFixes,
  classifyQueueVisibilityTransportFailure,
  renderOperationalProbeReportToon,
  runOperationalProbes,
} from "../src/core/operational-probes.js";

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
    ]);
    expect(decoded.findings).toHaveLength(1);
    expect(toon).not.toContain("{\n");
    expect(toon).not.toContain('": "');
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
});

function readFixture(name: string): Promise<string> {
  return readFile(join(process.cwd(), "tests", "fixtures", "github-transport", name), "utf8");
}
