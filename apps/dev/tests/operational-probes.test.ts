import { describe, expect, it, vi } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  applyOperationalProbeFixes,
  renderOperationalProbeReportToon,
  runOperationalProbes,
} from "../src/core/operational-probes.js";

describe("operational probe registry", () => {
  it("reports the HTTPS remote proof probe as red with a canonical fix", () => {
    const report = runOperationalProbes({
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

  it("leaves the proof probe green when the Actions lane allows HTTPS remotes", () => {
    const report = runOperationalProbes({
      remoteUrls: [{ name: "origin", url: "https://example.invalid/acme/widgets.git" }],
      allowHttpsRemote: true,
    });

    expect(report.findings).toEqual([]);
    expect(report.probes[0]?.verdict).toBe("ok");
  });

  it("renders AI-facing output as TOON", () => {
    const toon = renderOperationalProbeReportToon(
      runOperationalProbes({ remoteUrls: ["https://example.invalid/acme/widgets.git"] }),
    );
    const decoded = decode(toon) as { probes: Array<{ id: string; verdict: string }>; findings: unknown[] };

    expect(decoded.probes).toEqual([{ id: "git.remote.https-forbidden", name: "SSH-only git remotes", verdict: "red" }]);
    expect(decoded.findings).toHaveLength(1);
    expect(toon).not.toContain("{\n");
    expect(toon).not.toContain('": "');
  });

  it("refuses a gated fix without applying any remote changes", async () => {
    const report = runOperationalProbes({
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
    const report = runOperationalProbes({
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
});
