import { describe, expect, it } from "vitest";
import {
  auditMarketplaceSources,
  bootstrapRecipe,
  parseMarketplaceSource,
  renderMarketplaceSourceReportToon,
  RED_SKILLS_MARKETPLACE,
  type MarketplaceSourceFacts,
} from "../src/core/marketplace-source-doctor.js";

/**
 * The observed transcripts (Claude Code 2.1.x) for both registration shapes.
 * The Directory one is what red-dev writes; the GitHub one is what the retired
 * standalone installer left behind.
 */
const DIRECTORY_LIST = `Configured marketplaces:

  ❯ red-skills
    Source: Directory (/home/user/.red-dev/state/red-skills)
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
      detail: "/home/user/.red-dev/state/red-skills",
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
    Source: Directory (/home/user/.red/skills/versions/v3.3.0)
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
  // red-dev registers a directory source. Healing one back to the repository is
  // exactly how the retired installer tore out red-dev's wiring (#3978), so the
  // audit reports it and proposes nothing.
  it("passes a Directory-sourced marketplace clean, because red-dev owns it", () => {
    const report = auditMarketplaceSources([
      facts({ kind: "directory", detail: "/home/user/.red-dev/state/red-skills" }),
    ]);

    expect(report.rows).toEqual([
      {
        host: "claude",
        marketplace: "red-skills",
        source: "directory",
        detail: "/home/user/.red-dev/state/red-skills",
        verdict: "ok",
      },
    ]);
    expect(report.findings).toEqual([]);
  });

  it("reports a GitHub-sourced registration as the retired standalone installer's leftover", () => {
    const report = auditMarketplaceSources([facts({ detail: "reddb-io/red-skills" })]);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.kind).toBe("standalone-source");
    // A leftover still resolves, so it is a warning and never a red.
    expect(report.findings[0]!.verdict).toBe("warn");
    expect(report.findings[0]!.reason).toContain("red-dev owns RedSkills acquisition");
    expect(report.findings[0]!.remediation).toBe("mise use --global red-dev@1 && red-dev install");
    expect(report.rows[0]!.verdict).toBe("warn");
  });

  it("reports a git-remote registration the same way", () => {
    const report = auditMarketplaceSources([facts({ kind: "git", detail: "git@github.com:x/y" })]);

    expect(report.findings[0]!.kind).toBe("standalone-source");
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
      facts({ host: "claude", kind: "directory", detail: "/managed" }),
      facts({ host: "codex", kind: "github", detail: "reddb-io/red-skills" }),
    ]);

    expect(report.findings.map((finding) => finding.host)).toEqual(["codex"]);
  });

  // The cure is the bootstrap, never a registration this doctor writes itself.
  it("proposes the bootstrap and never a marketplace command", () => {
    expect(bootstrapRecipe()).toBe("mise use --global red-dev@1 && red-dev install");
    expect(bootstrapRecipe()).not.toContain("marketplace");
  });

  it("renders the report as TOON", () => {
    const toon = renderMarketplaceSourceReportToon(
      auditMarketplaceSources([facts({ kind: "github", detail: "reddb-io/red-skills" })]),
    );

    expect(toon).toContain("github");
    expect(toon).toContain("standalone-source");
  });
});

/**
 * The retired half of this doctor, pinned as a contract rather than left as an
 * absence nobody asserts. `applyMarketplaceSourceFixes` and `repointRecipe`
 * re-registered a Directory source at the GitHub repository — the exact move
 * that tore out red-dev's wiring and installed a second owner (#3978). The
 * capability is gone, so what the tests now hold is that it cannot come back:
 * a doctor whose worst act is a sentence cannot heal a machine into conflict.
 */
describe("the marketplace doctor reports and never writes", () => {
  it("exports no apply, repoint, or heal surface", async () => {
    const surface = await import("../src/core/marketplace-source-doctor.js");

    expect(Object.keys(surface).filter((name) => /apply|repoint|heal|fix|install/i.test(name))).toEqual([]);
  });

  it("never remediates by writing a registration, whatever the finding", () => {
    const report = auditMarketplaceSources([
      facts({ kind: "github", detail: "reddb-io/red-skills" }),
      facts({ host: "codex", kind: "unknown" }),
    ]);

    expect(report.findings.map((finding) => finding.kind)).toEqual([
      "standalone-source",
      "source-unknown",
    ]);
    for (const finding of report.findings) {
      // Reading a transcript back is fair; `marketplace add`/`remove` is the
      // write that made this doctor a second owner of the machine.
      expect(finding.remediation).not.toMatch(/marketplace\s+(?:add|remove)\b/i);
    }
    // The leftover standalone registration is cured by the bootstrap alone.
    expect(report.findings[0]!.remediation).toBe(bootstrapRecipe());
  });

  it("leaves a Directory registration untouched even when other hosts are dirty", () => {
    const report = auditMarketplaceSources([
      facts({ host: "claude", kind: "directory", detail: "/home/user/.red-dev/state/red-skills" }),
      facts({ host: "codex", kind: "github", detail: "reddb-io/red-skills" }),
    ]);

    expect(report.findings.map((finding) => finding.host)).toEqual(["codex"]);
    const directoryRow = report.rows.find((row) => row.source === "directory")!;
    expect(directoryRow.verdict).toBe("ok");
    expect(directoryRow.detail).toBe("/home/user/.red-dev/state/red-skills");
  });
});
