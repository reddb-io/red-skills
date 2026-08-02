import { describe, expect, it } from "vitest";
import {
  applyMarketplaceSourceFixes,
  auditMarketplaceSources,
  parseMarketplaceSource,
  renderMarketplaceSourceReportToon,
  repointRecipe,
  RED_SKILLS_MARKETPLACE,
  type MarketplaceSourceFacts,
} from "../src/core/marketplace-source-doctor.js";

/**
 * The observed transcripts (Claude Code 2.1.x) for both registration shapes.
 * The Directory one is what the installer used to write on every machine.
 */
const DIRECTORY_LIST = `Configured marketplaces:

  ❯ red-skills
    Source: Directory (/home/user/.red-skills/current)
`;

const GITHUB_LIST = `Configured marketplaces:

  ❯ red-skills
    Source: GitHub (reddb-io/red-skills)
`;

function facts(overrides: Partial<MarketplaceSourceFacts> = {}): MarketplaceSourceFacts {
  return {
    host: "claude",
    hostPresent: true,
    marketplace: RED_SKILLS_MARKETPLACE,
    kind: "github",
    ...overrides,
  };
}

describe("parseMarketplaceSource", () => {
  it("reads a Directory source and its path", () => {
    expect(parseMarketplaceSource(DIRECTORY_LIST, "red-skills")).toEqual({
      kind: "directory",
      detail: "/home/user/.red-skills/current",
    });
  });

  it("reads a GitHub source and its repo", () => {
    expect(parseMarketplaceSource(GITHUB_LIST, "red-skills")).toEqual({
      kind: "github",
      detail: "reddb-io/red-skills",
    });
  });

  it("reads the right entry when several marketplaces are registered", () => {
    const output = `Configured marketplaces:

    claude-plugins-official
    Source: GitHub (anthropics/claude-plugins-official)

  ❯ red-skills
    Source: Directory (/home/user/.red-skills/versions/v3.3.0)
`;

    expect(parseMarketplaceSource(output, "red-skills").kind).toBe("directory");
    expect(parseMarketplaceSource(output, "claude-plugins-official").kind).toBe("github");
  });

  it("reports an unregistered marketplace as absent", () => {
    expect(parseMarketplaceSource(GITHUB_LIST, "other-marketplace")).toEqual({ kind: "absent" });
  });

  // A command that could not run has told us nothing; calling that "absent"
  // would report a clean machine we never actually read.
  it("reports an unreadable transcript as unknown, not absent", () => {
    expect(parseMarketplaceSource(undefined, "red-skills")).toEqual({ kind: "unknown" });
  });
});

describe("auditMarketplaceSources", () => {
  it("flags a Directory-sourced red-skills marketplace as frozen", () => {
    const report = auditMarketplaceSources([
      facts({ kind: "directory", detail: "/home/user/.red-skills/current" }),
    ]);

    expect(report.rows).toEqual([
      {
        host: "claude",
        marketplace: "red-skills",
        source: "directory",
        detail: "/home/user/.red-skills/current",
        verdict: "error",
      },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.kind).toBe("frozen-directory-source");
    expect(report.findings[0]!.reason).toContain("can never advance");
    expect(report.findings[0]!.remediation).toBe(
      "claude plugin marketplace remove red-skills && claude plugin marketplace add reddb-io/red-skills",
    );
  });

  it("passes a GitHub-sourced marketplace clean", () => {
    const report = auditMarketplaceSources([facts({ detail: "reddb-io/red-skills" })]);

    expect(report.findings).toEqual([]);
    expect(report.rows[0]!.verdict).toBe("ok");
  });

  it("never flags a host that is not installed", () => {
    const report = auditMarketplaceSources([
      facts({ host: "codex", hostPresent: false, kind: "unknown" }),
    ]);

    expect(report.findings).toEqual([]);
    expect(report.rows[0]!.verdict).toBe("ok");
    expect(report.rows[0]!.detail).toBe("host not installed");
  });

  it("warns rather than reds when the source could not be read", () => {
    const report = auditMarketplaceSources([facts({ kind: "unknown" })]);

    expect(report.findings[0]!.verdict).toBe("warn");
    expect(report.findings[0]!.kind).toBe("source-unknown");
  });

  it("reports an unregistered marketplace as ok", () => {
    const report = auditMarketplaceSources([facts({ kind: "absent" })]);

    expect(report.findings).toEqual([]);
    expect(report.rows[0]!.verdict).toBe("ok");
  });

  it("audits every host independently", () => {
    const report = auditMarketplaceSources([
      facts({ host: "claude", kind: "directory", detail: "/snap" }),
      facts({ host: "codex", kind: "github", detail: "reddb-io/red-skills" }),
    ]);

    expect(report.findings.map((finding) => finding.host)).toEqual(["claude"]);
    expect(repointRecipe("codex")).toContain("codex plugin marketplace add reddb-io/red-skills");
  });

  it("renders the report as TOON", () => {
    const toon = renderMarketplaceSourceReportToon(
      auditMarketplaceSources([facts({ kind: "directory", detail: "/snap" })]),
    );

    expect(toon).toContain("directory");
    expect(toon).toContain("frozen-directory-source");
  });
});

describe("applyMarketplaceSourceFixes", () => {
  const frozen = auditMarketplaceSources([facts({ kind: "directory", detail: "/snap" })]);

  it("does nothing without --fix", async () => {
    const calls: string[] = [];
    const receipts = await applyMarketplaceSourceFixes(
      frozen,
      { fix: false, approved: true },
      {
        repoint: async (host) => {
          calls.push(host);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(receipts).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("skips an unapproved repoint without touching the host", async () => {
    const calls: string[] = [];
    const receipts = await applyMarketplaceSourceFixes(
      frozen,
      { fix: true, approved: false },
      {
        repoint: async (host) => {
          calls.push(host);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(calls).toEqual([]);
    expect(receipts).toEqual([
      { host: "claude", marketplace: "red-skills", status: "skipped", reason: "approval required" },
    ]);
  });

  it("repoints an approved frozen registration at the GitHub source", async () => {
    const calls: string[] = [];
    const receipts = await applyMarketplaceSourceFixes(
      frozen,
      { fix: true, approved: true },
      {
        repoint: async (host, marketplace) => {
          calls.push(`${host}:${marketplace}`);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(calls).toEqual(["claude:red-skills"]);
    expect(receipts[0]!.status).toBe("applied");
    expect(receipts[0]!.reason).toContain("reddb-io/red-skills");
  });

  it("records a failed repoint instead of claiming it applied", async () => {
    const receipts = await applyMarketplaceSourceFixes(
      frozen,
      { fix: true, approved: true },
      { repoint: async () => ({ code: 3, stdout: "", stderr: "boom" }) },
    );

    expect(receipts[0]).toEqual({
      host: "claude",
      marketplace: "red-skills",
      status: "failed",
      reason: "repoint exited 3",
    });
  });

  // Re-registering a marketplace we could not read would discard whatever the
  // operator actually configured.
  it("never repoints a source it could not read", async () => {
    const calls: string[] = [];
    const receipts = await applyMarketplaceSourceFixes(
      auditMarketplaceSources([facts({ kind: "unknown" })]),
      { fix: true, approved: true },
      {
        repoint: async (host) => {
          calls.push(host);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(calls).toEqual([]);
    expect(receipts[0]!.status).toBe("skipped");
  });
});
