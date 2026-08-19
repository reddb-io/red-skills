import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { auditHostBinaries, renderHostBinaryReportToon } from "../src/core/host-binary-doctor.js";

const CATALOG_TOON = { packageName: "@reddb-io/toon" as const, version: "0.3.0", tag: "v0.3.0" };

describe("auditHostBinaries — required host binary contract", () => {
  it("accepts a tq at the catalog floor", () => {
    const report = auditHostBinaries([
      { name: "tq", catalog: CATALOG_TOON, recordedVersion: "0.3.0", observedVersion: "0.3.0" },
    ]);

    expect(report.findings).toEqual([]);
    expect(report.rows).toEqual([
      { binary: "tq", catalog: "0.3.0", recorded: "0.3.0", observed: "0.3.0", verdict: "ok" },
    ]);
  });

  it("accepts a tq AHEAD of the catalog, because new readers read old files", () => {
    // The failure this check exists for is one-directional. An operator whose
    // only act was to run the current release used to be told to DOWNGRADE, to
    // match a catalog a broken watcher had failed to advance (#3466).
    for (const ahead of ["0.3.1", "0.4.0", "1.0.0"]) {
      const report = auditHostBinaries([
        { name: "tq", catalog: CATALOG_TOON, observedVersion: ahead },
      ]);
      expect(report.findings, `tq ${ahead} must be green against floor 0.3.0`).toEqual([]);
      expect(report.rows[0]?.verdict).toBe("ok");
    }
  });

  it("red-flags a tq BEHIND the floor, naming what it cannot do", () => {
    const report = auditHostBinaries([
      { name: "tq", catalog: CATALOG_TOON, observedVersion: "0.2.9" },
    ]);

    expect(report.findings[0]).toMatchObject({
      binary: "tq",
      kind: "toolchain-drift",
      verdict: "error",
      reason:
        "required host binary tq 0.2.9 is older than the floor 0.3.0, so it cannot read what this workspace writes",
    });
    expect(report.findings[0]?.remediation).toContain("cargo install reddb-io-tq --version 0.3.0 --locked --force");
    expect(report.rows[0]).toEqual({
      binary: "tq",
      catalog: "0.3.0",
      recorded: "missing",
      observed: "0.2.9",
      verdict: "error",
    });
  });

  it("red-flags missing tq with the canonical installer fix", () => {
    const report = auditHostBinaries([{ name: "tq", catalog: CATALOG_TOON }]);

    expect(report.findings).toEqual([
      {
        binary: "tq",
        kind: "missing",
        verdict: "error",
        reason: "required host binary tq is missing",
        remediation:
          "install pinned tq from crates.io with: cargo install reddb-io-tq --version 0.3.0 --locked --force",
      },
    ]);
  });

  it("never reads a prerelease or build suffix as newer than the release it precedes", () => {
    // Under-counting reddens; over-counting hides. A `0.3.0-next.4` is not the
    // 0.3.0 it leads up to, and must not pass as one.
    const report = auditHostBinaries([
      { name: "tq", catalog: { ...CATALOG_TOON, version: "0.3.1", tag: "v0.3.1" }, observedVersion: "0.3.0-next.4" },
    ]);
    expect(report.rows[0]?.verdict).toBe("error");
  });

  it("renders a compact TOON scorecard", () => {
    const toon = renderHostBinaryReportToon(
      auditHostBinaries([{ name: "tq", catalog: CATALOG_TOON, observedVersion: "0.0.9" }]),
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
