import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { auditHostBinaries, renderHostBinaryReportToon } from "../src/core/host-binary-doctor.js";

const CATALOG_TOON = { packageName: "@reddb-io/toon" as const, version: "0.3.0", tag: "v0.3.0" };

describe("auditHostBinaries — required host binary contract", () => {
  it("accepts the pinned tq version", () => {
    const report = auditHostBinaries([
      { name: "tq", catalog: CATALOG_TOON, recordedVersion: "0.3.0", observedVersion: "0.3.0" },
    ]);

    expect(report.findings).toEqual([]);
    expect(report.rows).toEqual([
      { binary: "tq", catalog: "0.3.0", recorded: "0.3.0", observed: "0.3.0", verdict: "ok" },
    ]);
  });

  it("red-flags missing tq with the canonical installer fix", () => {
    const report = auditHostBinaries([{ name: "tq", catalog: CATALOG_TOON, recordedVersion: "0.3.0" }]);

    expect(report.findings).toEqual([
      {
        binary: "tq",
        kind: "missing",
        verdict: "error",
        reason: "required host binary tq is missing",
        remediation:
          "install pinned tq with: TQ_VERSION=v0.3.0 curl -fsSL https://raw.githubusercontent.com/reddb-io/toon/v0.3.0/install.sh | sh",
      },
    ]);
  });

  it("red-flags tq toolchain drift naming catalog, config, and observed versions", () => {
    const report = auditHostBinaries([
      { name: "tq", catalog: CATALOG_TOON, recordedVersion: "0.2.0", observedVersion: "0.0.9" },
    ]);

    expect(report.findings[0]).toMatchObject({
      binary: "tq",
      kind: "toolchain-drift",
      verdict: "error",
      reason: "required host binary tq toolchain drift: catalog pin 0.3.0, config pin 0.2.0, observed tq 0.0.9",
    });
    expect(report.findings[0]?.remediation).toContain("TQ_VERSION=v0.3.0");
    expect(report.rows[0]).toEqual({
      binary: "tq",
      catalog: "0.3.0",
      recorded: "0.2.0",
      observed: "0.0.9",
      verdict: "error",
    });
  });

  it("renders a compact TOON scorecard", () => {
    const toon = renderHostBinaryReportToon(
      auditHostBinaries([
        { name: "tq", catalog: CATALOG_TOON, recordedVersion: "0.3.0", observedVersion: "0.0.9" },
      ]),
    );
    const decoded = decode(toon) as {
      binaries: Array<{ binary: string; catalog: string; recorded: string; observed: string; verdict: string }>;
      findings: Array<{ binary: string; kind: string; verdict: string }>;
    };

    expect(toon).toContain("binaries[1]{binary,catalog,recorded,observed,verdict}");
    expect(toon).toContain("findings[1]{binary,kind,verdict}");
    expect(decoded.findings).toEqual([{ binary: "tq", kind: "toolchain-drift", verdict: "error" }]);
    expect(toon).not.toContain("{\n");
  });
});
