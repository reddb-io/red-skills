import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  auditPluginRuntime,
  auditRuntimes,
  renderRuntimeReportToon,
  type PluginRuntimeFacts,
} from "../src/core/runtime-doctor.js";

/**
 * Fixture facts for one plugin. Defaults describe a HEALTHY plugin: enabled,
 * a present + readable + checksum-ok cached bundle whose version matches the
 * latest compatible release. Each test overrides just the field under audit.
 *
 * The key invariant of this whole module (like hook-doctor.ts) is that NOTHING
 * is ever fetched or read from disk — every fact is injected, so the audit is
 * a pure function of data. Prior art: hook-doctor.test.ts.
 */
function facts(overrides: Partial<PluginRuntimeFacts> = {}): PluginRuntimeFacts {
  return {
    plugin: "dev",
    enabled: true,
    installedVersion: "1.261.1",
    cache: { kind: "present", version: "1.261.1", readable: true, checksumOk: true },
    latestVersion: "1.261.1",
    ...overrides,
  };
}

describe("auditPluginRuntime — control-plane contract (ADR 0084)", () => {
  it("✅ healthy: enabled + present + readable + checksum-ok + up-to-date → no finding", () => {
    const { verdict, finding } = auditPluginRuntime(facts());
    expect(verdict).toBe("ok");
    expect(finding).toBeUndefined();
  });

  it("skips a disabled plugin entirely — inert by design is not a finding", () => {
    // A disabled plugin with a stale/missing cache is NOT a problem: the gate
    // (ADR 0067) keeps it inert on purpose. No finding, even with a bad cache.
    const { verdict, finding } = auditPluginRuntime(
      facts({ enabled: false, cache: { kind: "absent" } }),
    );
    expect(verdict).toBe("skip");
    expect(finding).toBeUndefined();
  });

  it("❌ enabled but runtime missing: no cached bundle → runtime-missing", () => {
    const { verdict, finding } = auditPluginRuntime(facts({ cache: { kind: "absent" } }));
    expect(verdict).toBe("error");
    expect(finding?.kind).toBe("runtime-missing");
    expect(finding?.verdict).toBe("error");
    expect(finding?.reason).toContain("enabled");
    // Remediation names the launcher fetch, not a hand edit.
    expect(finding?.remediation).toContain("red-fetch");
    // A re-fetch mutates the cache / hits the network → gated, not a safe batch.
    expect(finding?.fixGate).toBe("confirm");
  });

  it("❌ inert marker left by a failed fetch → inert-marker", () => {
    const { verdict, finding } = auditPluginRuntime(facts({ cache: { kind: "inert" } }));
    expect(verdict).toBe("error");
    expect(finding?.kind).toBe("inert-marker");
    expect(finding?.reason).toContain("failed fetch");
    expect(finding?.remediation).toContain("red-fetch");
    expect(finding?.fixGate).toBe("confirm");
  });

  it("❌ unreadable/corrupt cached bundle → cache-corrupt (checksum mismatch)", () => {
    const { verdict, finding } = auditPluginRuntime(
      facts({ cache: { kind: "present", version: "1.261.1", readable: true, checksumOk: false } }),
    );
    expect(verdict).toBe("error");
    expect(finding?.kind).toBe("cache-corrupt");
    expect(finding?.reason).toContain("checksum");
    expect(finding?.fixGate).toBe("confirm");
  });

  it("❌ unreadable cached bundle → cache-corrupt (unreadable)", () => {
    const { finding } = auditPluginRuntime(
      facts({ cache: { kind: "present", version: "1.261.1", readable: false, checksumOk: false } }),
    );
    expect(finding?.kind).toBe("cache-corrupt");
    expect(finding?.reason).toContain("unreadable");
  });

  it("⚠️ cached bundle behind the latest compatible release → version-drift", () => {
    const { verdict, finding } = auditPluginRuntime(
      facts({
        cache: { kind: "present", version: "1.260.0", readable: true, checksumOk: true },
        latestVersion: "1.261.1",
      }),
    );
    expect(verdict).toBe("warn");
    expect(finding?.kind).toBe("version-drift");
    expect(finding?.verdict).toBe("warn");
    expect(finding?.reason).toContain("1.260.0");
    expect(finding?.reason).toContain("1.261.1");
  });

  it("no drift finding when the latest release is unknown (can't resolve → no false positive)", () => {
    const { verdict, finding } = auditPluginRuntime(
      facts({
        cache: { kind: "present", version: "1.260.0", readable: true, checksumOk: true },
        latestVersion: undefined,
      }),
    );
    expect(verdict).toBe("ok");
    expect(finding).toBeUndefined();
  });

  it("no drift finding when cached version is ahead of the resolved latest", () => {
    const { finding } = auditPluginRuntime(
      facts({
        cache: { kind: "present", version: "1.262.0", readable: true, checksumOk: true },
        latestVersion: "1.261.1",
      }),
    );
    expect(finding).toBeUndefined();
  });

  it("corrupt takes precedence over drift when both hold", () => {
    const { finding } = auditPluginRuntime(
      facts({
        cache: { kind: "present", version: "1.260.0", readable: true, checksumOk: false },
        latestVersion: "1.261.1",
      }),
    );
    expect(finding?.kind).toBe("cache-corrupt");
  });
});

describe("auditRuntimes — per-plugin aggregate", () => {
  it("healthy three-plugin setup produces zero findings (negative test)", () => {
    const report = auditRuntimes([
      facts({ plugin: "dev" }),
      facts({ plugin: "memory" }),
      facts({ plugin: "brain" }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.rows.map((r) => r.verdict)).toEqual(["ok", "ok", "ok"]);
  });

  it("collects one finding per unhealthy plugin, healthy ones stay green", () => {
    const report = auditRuntimes([
      facts({ plugin: "dev", cache: { kind: "absent" } }),
      facts({ plugin: "memory", cache: { kind: "inert" } }),
      facts({ plugin: "brain" }), // healthy
    ]);
    expect(report.findings.map((f) => f.kind)).toEqual(["runtime-missing", "inert-marker"]);
    expect(report.findings.map((f) => f.plugin)).toEqual(["dev", "memory"]);
    const brain = report.rows.find((r) => r.plugin === "brain");
    expect(brain?.verdict).toBe("ok");
  });

  it("a disabled plugin shows as skip and contributes no finding", () => {
    const report = auditRuntimes([
      facts({ plugin: "dev" }),
      facts({ plugin: "memory", enabled: false, cache: { kind: "absent" } }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.rows.find((r) => r.plugin === "memory")?.verdict).toBe("skip");
  });
});

describe("renderRuntimeReportToon — TOON output (repo mandate)", () => {
  it("emits the per-plugin scorecard as TOON, not JSON", () => {
    const report = auditRuntimes([
      facts({ plugin: "dev", cache: { kind: "absent" } }),
      facts({ plugin: "memory" }),
      facts({ plugin: "brain", enabled: false, cache: { kind: "absent" } }),
    ]);
    const toon = renderRuntimeReportToon(report);
    const decoded = decode(toon) as {
      plugins: Array<{ plugin: string; enabled: boolean; state: string; verdict: string }>;
      findings: Array<{ plugin: string; kind: string; verdict: string }>;
    };
    // TOON tabular header for the uniform scorecard rows — never a JSON brace.
    expect(toon).toContain("plugins[3]{plugin,enabled,state,verdict}");
    expect(toon).toContain("findings[1]{plugin,kind,verdict}");
    expect(decoded.plugins.map((row) => row.plugin)).toEqual(["dev", "memory", "brain"]);
    expect(decoded.findings).toEqual([{ plugin: "dev", kind: "runtime-missing", verdict: "error" }]);
    expect(toon).not.toContain("{\n");
    expect(toon).not.toContain('": "');
  });
});
