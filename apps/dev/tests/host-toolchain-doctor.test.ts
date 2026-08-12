import { describe, expect, it, vi } from "vitest";
import {
  GH_MIN_VERSION,
  TQ_PINNED_VERSION,
  applyHostToolchainFixes,
  auditHostToolchain,
  detectGhInstallManager,
  parseToolVersion,
} from "../src/core/host-toolchain-doctor.js";

describe("host toolchain doctor", () => {
  it("parses gh and tq version output without depending on surrounding text", () => {
    expect(parseToolVersion("gh version 2.47.1 (2024-03-21)\nhttps://github.com/cli/cli/releases/tag/v2.47.1")).toBe("2.47.1");
    expect(parseToolVersion("tq 0.3.0\n")).toBe("0.3.0");
    expect(parseToolVersion("not a version")).toBeUndefined();
  });

  it("detects gh's install manager from injected host facts", () => {
    expect(detectGhInstallManager({ ghPath: "/opt/asdf/shims/gh", toolVersions: "github-cli 2.47.1\n" })).toBe("asdf");
    expect(detectGhInstallManager({ ghPath: "/users/operator/.asdf/shims/gh" })).toBe("asdf");
    expect(detectGhInstallManager({ ghPath: "/usr/bin/gh", aptManaged: true })).toBe("apt");
    expect(detectGhInstallManager({ ghPath: "/opt/homebrew/bin/gh", brewManaged: true })).toBe("brew");
    expect(detectGhInstallManager({ ghPath: "/usr/local/bin/gh" })).toBe("direct");
  });

  it("reports the gh minimum and pinned tq with manager-specific recipes", () => {
    const report = auditHostToolchain({
      ghOutput: "gh version 2.25.1 (2023-02-21)",
      ghPath: "/opt/asdf/shims/gh",
      toolVersions: "github-cli 2.25.1\n",
      tqRecordedVersion: TQ_PINNED_VERSION,
    });

    expect(GH_MIN_VERSION).toBe("2.47.0");
    expect(report.rows).toEqual([
      expect.objectContaining({ tool: "gh", version: "2.25.1", required: ">=2.47.0", manager: "asdf", verdict: "error" }),
      expect.objectContaining({ tool: "tq", version: "missing", required: TQ_PINNED_VERSION, verdict: "error" }),
    ]);
    expect(report.findings).toEqual([
      expect.objectContaining({ tool: "gh", kind: "outdated", remediation: "asdf install github-cli latest && asdf global github-cli latest && asdf reshim github-cli" }),
      expect.objectContaining({ tool: "tq", kind: "missing", remediation: `cargo install reddb-io-tq --version ${TQ_PINNED_VERSION} --locked --force` }),
    ]);
  });

  it("keeps the default doctor path mutation-free", async () => {
    const report = auditHostToolchain({
      ghOutput: "gh version 2.25.1",
      ghPath: "/opt/asdf/shims/gh",
      toolVersions: "github-cli 2.25.1\n",
      tqRecordedVersion: TQ_PINNED_VERSION,
    });
    const upgradeGhAsdf = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const installTq = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const receipts = await applyHostToolchainFixes(report, { fix: false, approved: true }, { upgradeGhAsdf, installTq });

    expect(receipts).toEqual([]);
    expect(upgradeGhAsdf).not.toHaveBeenCalled();
    expect(installTq).not.toHaveBeenCalled();
  });

  it("applies only approved asdf gh and canonical tq fixes", async () => {
    const report = auditHostToolchain({
      ghOutput: "gh version 2.25.1",
      ghPath: "/opt/asdf/shims/gh",
      toolVersions: "github-cli 2.25.1\n",
      tqRecordedVersion: TQ_PINNED_VERSION,
    });
    const upgradeGhAsdf = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const installTq = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    expect(await applyHostToolchainFixes(report, { fix: true, approved: false }, { upgradeGhAsdf, installTq })).toEqual([
      expect.objectContaining({ tool: "gh", status: "skipped", reason: "approval required" }),
      expect.objectContaining({ tool: "tq", status: "skipped", reason: "approval required" }),
    ]);
    expect(upgradeGhAsdf).not.toHaveBeenCalled();
    expect(installTq).not.toHaveBeenCalled();

    const receipts = await applyHostToolchainFixes(report, { fix: true, approved: true }, { upgradeGhAsdf, installTq });
    expect(receipts).toEqual([
      expect.objectContaining({ tool: "gh", status: "applied" }),
      expect.objectContaining({ tool: "tq", status: "applied" }),
    ]);
    expect(upgradeGhAsdf).toHaveBeenCalledOnce();
    expect(installTq).toHaveBeenCalledOnce();
  });

  it("never executes sudo-backed gh fixes", async () => {
    const report = auditHostToolchain({ ghOutput: "gh version 2.25.1", ghPath: "/usr/bin/gh", aptManaged: true, tqOutput: `tq ${TQ_PINNED_VERSION}`, tqRecordedVersion: TQ_PINNED_VERSION });
    const upgradeGhAsdf = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const installTq = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

    const receipts = await applyHostToolchainFixes(report, { fix: true, approved: true }, { upgradeGhAsdf, installTq });

    expect(receipts).toEqual([expect.objectContaining({ tool: "gh", status: "instruction", reason: "sudo-backed apt upgrade is report-only" })]);
    expect(upgradeGhAsdf).not.toHaveBeenCalled();
  });

  it("does not echo command stderr into public fix receipts", async () => {
    const report = auditHostToolchain({
      ghOutput: "gh version 2.25.1",
      ghPath: "/opt/asdf/shims/gh",
      toolVersions: "github-cli 2.25.1\n",
      tqOutput: `tq ${TQ_PINNED_VERSION}`,
      tqRecordedVersion: TQ_PINNED_VERSION,
    });
    const receipts = await applyHostToolchainFixes(
      report,
      { fix: true, approved: true },
      {
        upgradeGhAsdf: async () => ({ code: 7, stdout: "", stderr: "sensitive host path [REDACTED_HOME]" }),
        installTq: async () => ({ code: 0, stdout: "", stderr: "" }),
      },
    );

    expect(receipts).toEqual([{ tool: "gh", status: "failed", reason: "command exited 7" }]);
  });
});
