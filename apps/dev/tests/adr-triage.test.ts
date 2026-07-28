import { describe, expect, it } from "vitest";
import {
  type AdrRecord,
  type AdrTriageContext,
  detectAdrInconsistencies,
  groupAdrs,
  triageAdrs,
} from "../src/core/adr-triage.js";

// ---------------------------------------------------------------------------
// fixture ADR tree
// ---------------------------------------------------------------------------

function adr(number: string, overrides: Partial<AdrRecord> = {}): AdrRecord {
  return {
    number,
    path: `.red/adr/${number}-fixture.md`,
    title: `Fixture ADR ${number}`,
    status: "Accepted.",
    body: "## Decision\n\n- **Do the thing.** Because.\n",
    ageDays: 10,
    ...overrides,
  };
}

/** A tree with one ADR per bucket, plus the partners those buckets need. */
function fixtureTree(): AdrTriageContext {
  return {
    adrs: [
      // keep — live, linked, recent, single decision, no stale paths
      adr("0001", {
        title: "Memory transport adapters",
        body: "## Decision\n\n- **Register adapters.** See `apps/memory/src/index.ts`.\n",
      }),
      // archive-candidate — terminal status
      adr("0002", { status: "Superseded by ADR-0003." }),
      // the successor, which keeps 0002 honest
      adr("0003", {
        title: "Successor record",
        body: "## Decision\n\n- **Supersedes ADR-0002.** New shape.\n",
      }),
      // missing-supersession — 0005 supersedes it, but its own status never said so
      adr("0004", { status: "Accepted." }),
      adr("0005", {
        title: "Replacement record",
        body: "## Decision\n\n- **Supersedes ADR-0004.** Newer shape.\n",
      }),
      // stale-reference — cites a path that no longer exists
      adr("0006", {
        body: "## Decision\n\n- **Read the launcher.** See `apps/dev/src/gone.ts`.\n",
      }),
      // split-candidate — one ADR carrying many decisions
      adr("0007", {
        body: [
          "## Decision",
          "",
          "- **One.** a",
          "- **Two.** b",
          "- **Three.** c",
          "- **Four.** d",
          "- **Five.** e",
          "",
        ].join("\n"),
      }),
      // merge-candidate pair — near-identical subjects
      adr("0008", { title: "AFK worker heartbeat protocol" }),
      adr("0009", { title: "AFK worker heartbeat sampling" }),
      // archive-candidate — accepted but old and nothing links to it
      adr("0010", { title: "Inert shipped decision", ageDays: 900 }),
    ],
    existingPaths: ["apps/memory/src/index.ts", "apps/dev/src/cli.ts"],
    indexSections: [{ title: "AFK", numbers: ["0008", "0009"] }],
  };
}

function bucketsByNumber(context: AdrTriageContext, subject?: Parameters<typeof triageAdrs>[1]) {
  const report = triageAdrs(context, subject);
  return Object.fromEntries(report.entries.map((entry) => [entry.number, entry.bucket]));
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("triageAdrs", () => {
  it("buckets every ADR in the fixture tree", () => {
    expect(bucketsByNumber(fixtureTree())).toEqual({
      "0001": "keep",
      "0002": "archive-candidate",
      "0003": "keep",
      "0004": "missing-supersession",
      "0005": "keep",
      "0006": "stale-reference",
      "0007": "split-candidate",
      "0008": "merge-candidate",
      "0009": "merge-candidate",
      "0010": "archive-candidate",
    });
  });

  it("counts each bucket", () => {
    const report = triageAdrs(fixtureTree());

    expect(report.countsByBucket).toEqual({
      keep: 3,
      "stale-reference": 1,
      "missing-supersession": 1,
      "merge-candidate": 2,
      "split-candidate": 1,
      "archive-candidate": 2,
    });
  });

  it("names the evidence behind each bucket", () => {
    const report = triageAdrs(fixtureTree());
    const entry = (number: string) => report.entries.find((item) => item.number === number)!;

    expect(entry("0002").signals).toContain("superseded-by:0003");
    expect(entry("0004").signals).toContain("superseded-without-status:0005");
    expect(entry("0006").signals).toContain("stale-path:apps/dev/src/gone.ts");
    expect(entry("0007").signals).toContain("decision-points:5");
    expect(entry("0008").signals).toContain("overlaps:0009");
    expect(entry("0010").signals).toContain("inbound-links:0");
    expect(entry("0002").reason).toMatch(/supersed/i);
  });

  it("skips stale-path detection when the caller supplies no path inventory", () => {
    const context = { ...fixtureTree(), existingPaths: undefined };

    expect(bucketsByNumber(context)["0006"]).toBe("keep");
  });

  it("treats a superseded status with no successor number as missing supersession", () => {
    const context: AdrTriageContext = {
      adrs: [adr("0020", { status: "Superseded." })],
    };
    const report = triageAdrs(context);

    expect(report.entries[0]!.bucket).toBe("missing-supersession");
    expect(report.entries[0]!.signals).toContain("successor-unnamed");
  });

  it("archives a deprecated ADR", () => {
    const context: AdrTriageContext = { adrs: [adr("0021", { status: "Deprecated." })] };

    expect(triageAdrs(context).entries[0]!.bucket).toBe("archive-candidate");
  });

  it("keeps an old ADR that other ADRs still link to", () => {
    const context: AdrTriageContext = {
      adrs: [
        adr("0030", { title: "Old but load-bearing", ageDays: 900 }),
        adr("0031", { body: "## Decision\n\n- **Follow ADR-0030.** Still current.\n" }),
      ],
    };

    expect(bucketsByNumber(context)["0030"]).toBe("keep");
  });

  it("is pure — it does not mutate the records it classifies", () => {
    const context = fixtureTree();
    const snapshot = JSON.parse(JSON.stringify(context));

    triageAdrs(context);

    expect(JSON.parse(JSON.stringify(context))).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// subject filter
// ---------------------------------------------------------------------------

describe("triageAdrs subject filter", () => {
  it("scopes the report to an explicit set of ADR numbers", () => {
    const report = triageAdrs(fixtureTree(), { subject: { kind: "numbers", numbers: ["0002", "0007"] } });

    expect(report.entries.map((entry) => entry.number)).toEqual(["0002", "0007"]);
    expect(report.subject).toEqual({ kind: "numbers", matched: ["0002", "0007"], unmatched: [] });
  });

  it("reports numbers the tree does not contain", () => {
    const report = triageAdrs(fixtureTree(), { subject: { kind: "numbers", numbers: ["0002", "9999"] } });

    expect(report.subject?.unmatched).toEqual(["9999"]);
  });

  it("scopes the report to a free-text subject", () => {
    const report = triageAdrs(fixtureTree(), { subject: { kind: "text", query: "AFK heartbeat" } });

    expect(report.entries.map((entry) => entry.number)).toEqual(["0008", "0009"]);
  });

  it("scopes the report to an INDEX section", () => {
    const report = triageAdrs(fixtureTree(), { subject: { kind: "index-section", section: "afk" } });

    expect(report.entries.map((entry) => entry.number)).toEqual(["0008", "0009"]);
  });

  it("returns nothing for an unknown INDEX section", () => {
    const report = triageAdrs(fixtureTree(), { subject: { kind: "index-section", section: "nope" } });

    expect(report.entries).toEqual([]);
  });

  it("classifies against the whole tree even when the report is scoped", () => {
    // 0004's bucket depends on 0005, which the filter excludes. The signal must survive.
    const report = triageAdrs(fixtureTree(), { subject: { kind: "numbers", numbers: ["0004"] } });

    expect(report.entries[0]!.bucket).toBe("missing-supersession");
  });

  it("counts only the scoped entries", () => {
    const report = triageAdrs(fixtureTree(), { subject: { kind: "numbers", numbers: ["0002"] } });

    expect(report.countsByBucket["archive-candidate"]).toBe(1);
    expect(report.countsByBucket.keep).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------

describe("groupAdrs", () => {
  it("groups by INDEX theme first, then clusters what no theme claims", () => {
    const report = groupAdrs(fixtureTree());
    const byTitle = Object.fromEntries(report.groups.map((group) => [group.title, group]));

    expect(byTitle.AFK!.kind).toBe("index-section");
    expect(byTitle.AFK!.numbers).toEqual(["0008", "0009"]);
    // Every remaining fixture ADR is a lone subject, so nothing else clusters.
    expect(report.groups.filter((group) => group.kind === "subject-cluster")).toEqual([]);
    expect(report.ungrouped).toEqual(["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0010"]);
  });

  it("clusters records that share a subject but no INDEX section", () => {
    const context: AdrTriageContext = {
      adrs: [
        adr("0001", { title: "Castle owns execution truth" }),
        adr("0002", { title: "Castle owns execution policy" }),
        adr("0003", { title: "Unrelated licensing choice" }),
      ],
    };
    const report = groupAdrs(context);

    expect(report.groups).toEqual([
      { kind: "subject-cluster", title: "castle + execution + owns", numbers: ["0001", "0002"] },
    ]);
    expect(report.ungrouped).toEqual(["0003"]);
  });

  it("clusters against the whole tree even when the report is scoped", () => {
    const context: AdrTriageContext = {
      adrs: [
        adr("0001", { title: "Castle owns execution truth" }),
        adr("0002", { title: "Castle owns execution policy" }),
      ],
    };
    const report = groupAdrs(context, { subject: { kind: "numbers", numbers: ["0001", "0099"] } });

    expect(report.groups).toEqual([
      { kind: "subject-cluster", title: "castle + execution + owns", numbers: ["0001"] },
    ]);
    expect(report.subject).toEqual({ kind: "numbers", matched: ["0001"], unmatched: ["0099"] });
  });
});

// ---------------------------------------------------------------------------
// inconsistency detection
// ---------------------------------------------------------------------------

describe("detectAdrInconsistencies", () => {
  it("reports a pointer whose target is not in the tree", () => {
    const report = detectAdrInconsistencies({
      adrs: [adr("0001", { status: "Superseded by ADR-0999." })],
    });

    expect(report.inconsistencies).toContainEqual({
      kind: "dangling-supersede",
      numbers: ["0001"],
      detail: "ADR 0001 points at ADR 0999, which is not in the tree.",
    });
  });

  it("reports two records that each claim the other as successor", () => {
    const report = detectAdrInconsistencies({
      adrs: [
        adr("0001", { status: "Superseded by ADR-0002." }),
        adr("0002", { status: "Superseded by ADR-0001." }),
      ],
    });

    expect(report.countsByKind["supersession-cycle"]).toBe(1);
    expect(report.inconsistencies.find((finding) => finding.kind === "supersession-cycle")!.numbers).toEqual([
      "0001",
      "0002",
    ]);
  });

  it("reports a number claimed by two files", () => {
    const report = detectAdrInconsistencies({
      adrs: [adr("0001", { path: ".red/adr/0001-a.md" }), adr("0001", { path: ".red/adr/0001-b.md" })],
    });

    expect(report.inconsistencies[0]).toEqual({
      kind: "numbering-collision",
      numbers: ["0001"],
      detail: "ADR number 0001 is claimed by 2 records: .red/adr/0001-a.md, .red/adr/0001-b.md.",
    });
  });

  it("reports INDEX drift in both directions", () => {
    const report = detectAdrInconsistencies({
      adrs: [adr("0001"), adr("0002")],
      indexNumbers: ["0001", "0003"],
    });
    const drift = report.inconsistencies.filter((finding) => finding.kind === "index-drift");

    expect(drift.map((finding) => finding.detail)).toEqual([
      "ADR 0002 exists in the tree but has no INDEX bullet.",
      "INDEX documents ADR 0003, which is not in the tree.",
    ]);
  });

  it("skips INDEX drift entirely when no INDEX numbers are supplied", () => {
    const report = detectAdrInconsistencies({ adrs: [adr("0001")] });

    expect(report.countsByKind["index-drift"]).toBe(0);
  });

  it("reports stale paths, unrecorded supersession, and subject overlap in the fixture tree", () => {
    const report = detectAdrInconsistencies(fixtureTree());

    expect(report.countsByKind["stale-path"]).toBe(1);
    expect(report.countsByKind["missing-supersession"]).toBe(1);
    expect(report.countsByKind["subject-overlap"]).toBe(1);
    expect(report.inconsistencies.find((finding) => finding.kind === "subject-overlap")!.numbers).toEqual([
      "0008",
      "0009",
    ]);
  });

  it("never reports an overlap between terminal records", () => {
    const report = detectAdrInconsistencies({
      adrs: [
        adr("0001", { title: "AFK worker heartbeat protocol", status: "Superseded by ADR-0002." }),
        adr("0002", { title: "AFK worker heartbeat sampling" }),
      ],
    });

    expect(report.countsByKind["subject-overlap"]).toBe(0);
  });

  it("keeps only findings that implicate a scoped record", () => {
    const report = detectAdrInconsistencies(fixtureTree(), {
      subject: { kind: "numbers", numbers: ["0006"] },
    });

    expect(report.inconsistencies.map((finding) => finding.kind)).toEqual(["stale-path"]);
  });
});
