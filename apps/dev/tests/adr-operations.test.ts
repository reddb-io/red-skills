import { describe, expect, it } from "vitest";
import {
  applyAbsorb,
  applyArchiveMove,
  applyComposite,
  applyIndexArchive,
  applyRenumber,
  applyStalePathFix,
  applyStatusAndSuccessor,
  planAbsorb,
  planArchiveMove,
  planIndexArchive,
  planIndexEntry,
  planIndexReviewAnnotation,
  planMerge,
  planRenumber,
  planSplit,
  planStalePathFix,
  planStatusAndSuccessor,
} from "../src/core/adr-operations.js";

const ADR = [
  "# Retired decision",
  "",
  "## Status",
  "",
  "Accepted.",
  "",
  "## Context",
  "",
  "The old runtime lives at `apps/old/runtime.ts`.",
  "",
  "## Decision",
  "",
  "Keep `apps/old/runtime.ts` as the canonical runtime.",
  "",
  "## Consequences",
  "",
  "Callers use the old runtime.",
  "",
].join("\n");

const INDEX = [
  "# ADR Index",
  "",
  "## Active",
  "",
  "- **0001** Live decision",
  "- **0002** Retired decision",
  "",
  "## Archived",
  "",
  "Retired records stay documented here.",
  "",
  "_The archive is empty — no ADR has been retired yet._",
  "",
].join("\n");

function decision(text: string): string {
  return text.match(/^## Decision\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1] ?? "";
}

describe("planStatusAndSuccessor", () => {
  it("sets a terminal status and successor pointer without changing the Decision", () => {
    const plan = planStatusAndSuccessor({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      status: "superseded",
      successors: ["0113"],
    });

    expect(plan).toEqual({
      path: ".red/adr/0002-retired.md",
      text: ADR.replace(
        "## Status\n\nAccepted.",
        "## Status\n\nSuperseded by ADR 0113.\n\nsuperseded-by: 0113",
      ),
    });
    expect(decision(plan.text)).toBe(decision(ADR));
  });

  it.each([
    {
      status: "deprecated" as const,
      successors: ["0113"],
      rendered: "Deprecated; superseded by ADR 0113.\n\nsuperseded-by: 0113",
    },
    {
      status: "inert" as const,
      successors: [],
      rendered: "Inert — fully shipped, no longer guidance.\n\nsuperseded-by: none (inert)",
    },
  ])("renders the $status terminal status and governance pointer", ({ status, successors, rendered }) => {
    const plan = planStatusAndSuccessor({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      status,
      successors,
    });

    expect(plan.text).toBe(ADR.replace("## Status\n\nAccepted.", `## Status\n\n${rendered}`));
    expect(decision(plan.text)).toBe(decision(ADR));
  });

  it("adds Status frontmatter when a compact ADR has none", () => {
    const compact = ADR.replace("\n## Status\n\nAccepted.\n", "");
    const plan = planStatusAndSuccessor({
      path: ".red/adr/0002-retired.md",
      text: compact,
      status: "superseded",
      successors: ["0113"],
    });

    expect(plan.text).toBe(compact.replace(
      "# Retired decision\n",
      "# Retired decision\n\n## Status\n\nSuperseded by ADR 0113.\n\nsuperseded-by: 0113\n",
    ));
    expect(decision(plan.text)).toBe(decision(compact));
  });

  it("preserves compact ADR history and related links inside Status", () => {
    const compact = ADR.replace(
      "Accepted.",
      "Accepted.\n\nShipped incrementally after the original rollout.\n\nRelated: ADR 0001 and issue #42.",
    );
    const plan = planStatusAndSuccessor({
      path: ".red/adr/0002-retired.md",
      text: compact,
      status: "superseded",
      successors: ["0113"],
    });

    expect(plan.text).toBe(compact.replace(
      "Accepted.",
      "Superseded by ADR 0113.\n\nsuperseded-by: 0113",
    ));
    expect(plan.text).toContain("Shipped incrementally after the original rollout.");
    expect(plan.text).toContain("Related: ADR 0001 and issue #42.");
    expect(decision(plan.text)).toBe(decision(compact));
  });

  it.each([
    ["a non-numeric successor", ["next"]],
    ["an invalid later successor", ["0113", "next"]],
  ])("rejects %s", (_case, successors) => {
    expect(() => planStatusAndSuccessor({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      status: "superseded",
      successors,
    })).toThrow("Invalid ADR successor: next");
  });

  it("applies the planned ADR text through the injected filesystem", async () => {
    const writes: Array<[string, string]> = [];
    const plan = planStatusAndSuccessor({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      status: "superseded",
      successors: ["0113"],
    });

    await applyStatusAndSuccessor(plan, {
      writeFile: async (path, text) => {
        writes.push([path, text]);
      },
    });

    expect(writes).toEqual([[plan.path, plan.text]]);
  });
});

describe("planIndexArchive", () => {
  it("moves the ADR bullet into Archived without changing its text", () => {
    const plan = planIndexArchive({
      path: ".red/adr/INDEX.md",
      text: INDEX,
      number: "0002",
    });

    expect(plan).toEqual({
      path: ".red/adr/INDEX.md",
      text: INDEX.replace("- **0002** Retired decision\n", "").replace(
        "_The archive is empty — no ADR has been retired yet._",
        "- **0002** Retired decision",
      ),
    });
  });

  it("appends the moved bullet when Archived already contains records", () => {
    const nonEmpty = INDEX.replace(
      "_The archive is empty — no ADR has been retired yet._",
      "- **0003** Previously retired decision",
    );
    const plan = planIndexArchive({ path: ".red/adr/INDEX.md", text: nonEmpty, number: "0002" });

    expect(plan.text).toBe(
      nonEmpty
        .replace("- **0002** Retired decision\n", "")
        .replace(
          "- **0003** Previously retired decision",
          "- **0003** Previously retired decision\n- **0002** Retired decision",
        ),
    );
  });

  it("applies the INDEX resync through the injected filesystem", async () => {
    const writes: Array<[string, string]> = [];
    const plan = planIndexArchive({ path: ".red/adr/INDEX.md", text: INDEX, number: "0002" });

    await applyIndexArchive(plan, {
      writeFile: async (path, text) => {
        writes.push([path, text]);
      },
    });

    expect(writes).toEqual([[plan.path, plan.text]]);
  });
});

describe("planIndexReviewAnnotation", () => {
  it("visibly stamps a reviewed bullet and replaces an older review marker", () => {
    const first = planIndexReviewAnnotation({
      path: ".red/adr/INDEX.md",
      text: INDEX,
      number: "0001",
      reviewedOn: "2026-08-04",
      baseSha: "abc1234",
    });
    const second = planIndexReviewAnnotation({
      path: first.path,
      text: first.text,
      number: "0001",
      reviewedOn: "2026-09-10",
      baseSha: "def5678",
    });

    expect(first.text).toContain("- **0001** Live decision — reviewed 2026-08-04 @ abc1234");
    expect(second.text).toContain("- **0001** Live decision — reviewed 2026-09-10 @ def5678");
    expect(second.text).not.toContain("reviewed 2026-08-04");
    expect(second.text.match(/reviewed /g)).toHaveLength(1);
  });
});

describe("planArchiveMove", () => {
  it("plans a terminal ADR move and INDEX resync as one reversible change", () => {
    const plan = planArchiveMove({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
      status: "superseded",
      successors: ["0113"],
    });

    expect(plan).toEqual({
      from: ".red/adr/0002-retired.md",
      to: ".red/adr/archive/0002-retired.md",
      originalAdrText: ADR,
      adrText: ADR.replace(
        "## Status\n\nAccepted.",
        "## Status\n\nSuperseded by ADR 0113.\n\nsuperseded-by: 0113",
      ),
      indexPath: ".red/adr/INDEX.md",
      originalIndexText: INDEX,
      indexText: INDEX.replace("- **0002** Retired decision\n", "").replace(
        "_The archive is empty — no ADR has been retired yet._",
        "- **0002** Retired decision",
      ),
    });
    expect(decision(plan.adrText)).toBe(decision(ADR));
  });

  it("writes terminal metadata, uses git mv, then writes the resynced INDEX", async () => {
    const events: string[] = [];
    const plan = planArchiveMove({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
      status: "superseded",
      successors: ["0113"],
    });

    await applyArchiveMove(plan, {
      fs: {
        writeFile: async (path, text) => {
          events.push(`write:${path}:${text === plan.adrText ? "adr" : "index"}`);
        },
      },
      git: {
        mv: async (from, to) => {
          events.push(`git-mv:${from}:${to}`);
        },
      },
    });

    expect(events).toEqual([
      "write:.red/adr/0002-retired.md:adr",
      "git-mv:.red/adr/0002-retired.md:.red/adr/archive/0002-retired.md",
      "write:.red/adr/INDEX.md:index",
    ]);
  });

  it("restores the original ADR when the terminal metadata write fails", async () => {
    const events: string[] = [];
    const plan = planArchiveMove({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
      status: "superseded",
      successors: ["0113"],
    });
    let writes = 0;

    await expect(applyArchiveMove(plan, {
      fs: {
        writeFile: async (path, text) => {
          events.push(`write:${path}:${text === ADR ? "original" : "planned"}`);
          if (writes++ === 0) throw new Error("ADR write failed");
        },
      },
      git: {
        mv: async (from, to) => {
          events.push(`git-mv:${from}:${to}`);
        },
      },
    })).rejects.toThrow("ADR write failed");

    expect(events).toEqual([
      "write:.red/adr/0002-retired.md:planned",
      "write:.red/adr/0002-retired.md:original",
    ]);
  });

  it("restores the original ADR when git mv fails", async () => {
    const events: string[] = [];
    const plan = planArchiveMove({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
      status: "superseded",
      successors: ["0113"],
    });

    await expect(applyArchiveMove(plan, {
      fs: {
        writeFile: async (path, text) => {
          events.push(`write:${path}:${text === ADR ? "original" : "planned"}`);
        },
      },
      git: {
        mv: async (from, to) => {
          events.push(`git-mv:${from}:${to}`);
          throw new Error("git mv failed");
        },
      },
    })).rejects.toThrow("git mv failed");

    expect(events).toEqual([
      "write:.red/adr/0002-retired.md:planned",
      "git-mv:.red/adr/0002-retired.md:.red/adr/archive/0002-retired.md",
      "write:.red/adr/0002-retired.md:original",
    ]);
  });

  it("restores the INDEX, move, and ADR when the INDEX write fails", async () => {
    const events: string[] = [];
    const plan = planArchiveMove({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
      status: "superseded",
      successors: ["0113"],
    });

    await expect(applyArchiveMove(plan, {
      fs: {
        writeFile: async (path, text) => {
          const version = text === ADR || text === INDEX ? "original" : "planned";
          events.push(`write:${path}:${version}`);
          if (path === plan.indexPath && text === plan.indexText) {
            throw new Error("INDEX write failed");
          }
        },
      },
      git: {
        mv: async (from, to) => {
          events.push(`git-mv:${from}:${to}`);
        },
      },
    })).rejects.toThrow("INDEX write failed");

    expect(events).toEqual([
      "write:.red/adr/0002-retired.md:planned",
      "git-mv:.red/adr/0002-retired.md:.red/adr/archive/0002-retired.md",
      "write:.red/adr/INDEX.md:planned",
      "write:.red/adr/INDEX.md:original",
      "git-mv:.red/adr/archive/0002-retired.md:.red/adr/0002-retired.md",
      "write:.red/adr/0002-retired.md:original",
    ]);
  });
});

describe("planStalePathFix", () => {
  it("replaces stale prose with a note while leaving the Decision occurrence intact", () => {
    const plan = planStalePathFix({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      stalePath: "apps/old/runtime.ts",
      replacementPath: "apps/new/runtime.ts",
      note: "moved in ADR 0113",
    });

    expect(plan).toEqual({
      path: ".red/adr/0002-retired.md",
      text: ADR.replace(
        "`apps/old/runtime.ts`.",
        "`apps/new/runtime.ts` *(stale-path note: moved in ADR 0113)*.",
      ),
    });
    expect(decision(plan.text)).toBe(decision(ADR));
    expect(decision(plan.text)).toContain("`apps/old/runtime.ts`");
  });

  it("applies the prose repair through the injected filesystem", async () => {
    const writes: Array<[string, string]> = [];
    const plan = planStalePathFix({
      path: ".red/adr/0002-retired.md",
      text: ADR,
      stalePath: "apps/old/runtime.ts",
      replacementPath: "apps/new/runtime.ts",
      note: "moved in ADR 0113",
    });

    await applyStalePathFix(plan, {
      writeFile: async (path, text) => {
        writes.push([path, text]);
      },
    });

    expect(writes).toEqual([[plan.path, plan.text]]);
  });
});

// ---------------------------------------------------------------------------
// renumber
// ---------------------------------------------------------------------------

const NUMBERED = ["# 0002 — Retired decision", "", "## Status", "", "Accepted.", ""].join("\n");

describe("planRenumber", () => {
  it("moves the file, the H1, and the INDEX bullet together", () => {
    const plan = planRenumber({
      path: ".red/adr/0002-retired.md",
      text: NUMBERED,
      toNumber: "0087",
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

    expect(plan.from).toBe(".red/adr/0002-retired.md");
    expect(plan.to).toBe(".red/adr/0087-retired.md");
    expect(plan.adrText).toContain("# 0087 — Retired decision");
    expect(plan.indexText).toContain("- **0087** Retired decision");
    expect(plan.indexText).not.toContain("- **0002**");
  });

  it("renumbers a record that already lives in the archive lane", () => {
    const plan = planRenumber({
      path: ".red/adr/archive/0002-retired.md",
      text: NUMBERED,
      toNumber: "0087",
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

    expect(plan.to).toBe(".red/adr/archive/0087-retired.md");
  });

  it.each([
    { toNumber: "87", reason: "Invalid ADR number: 87" },
    { toNumber: "0002", reason: "ADR 0002 already has that number" },
    { toNumber: "0001", reason: "ADR number 0001 already has an INDEX bullet" },
  ])("refuses $toNumber", ({ toNumber, reason }) => {
    expect(() =>
      planRenumber({
        path: ".red/adr/0002-retired.md",
        text: NUMBERED,
        toNumber,
        indexPath: ".red/adr/INDEX.md",
        indexText: INDEX,
      }),
    ).toThrow(reason);
  });

  it("refuses an H1 whose number contradicts the filename", () => {
    expect(() =>
      planRenumber({
        path: ".red/adr/0002-retired.md",
        text: NUMBERED.replace("# 0002", "# 0003"),
        toNumber: "0087",
        indexPath: ".red/adr/INDEX.md",
        indexText: INDEX,
      }),
    ).toThrow("ADR H1 says 0003, filename says 0002");
  });

  it("applies the renumber with a real git move", async () => {
    const writes: Array<[string, string]> = [];
    const moves: Array<[string, string]> = [];
    const plan = planRenumber({
      path: ".red/adr/0002-retired.md",
      text: NUMBERED,
      toNumber: "0087",
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

    await applyRenumber(plan, {
      fs: {
        writeFile: async (path, text) => {
          writes.push([path, text]);
        },
      },
      git: {
        mv: async (from, to) => {
          moves.push([from, to]);
        },
      },
    });

    expect(moves).toEqual([[".red/adr/0002-retired.md", ".red/adr/0087-retired.md"]]);
    expect(writes).toEqual([
      [".red/adr/0002-retired.md", plan.adrText],
      [".red/adr/INDEX.md", plan.indexText],
    ]);
  });
});

// ---------------------------------------------------------------------------
// re-index
// ---------------------------------------------------------------------------

describe("planIndexEntry", () => {
  it("adds a bullet at the end of the named section", () => {
    const plan = planIndexEntry({
      path: ".red/adr/INDEX.md",
      text: INDEX,
      number: "0003",
      entry: "Brand new decision",
      section: "Active",
    });

    expect(plan.text).toContain("- **0002** Retired decision\n- **0003** Brand new decision");
  });

  it("moves an existing bullet instead of duplicating it", () => {
    const plan = planIndexEntry({
      path: ".red/adr/INDEX.md",
      text: INDEX,
      number: "0001",
      entry: "Relocated decision",
      section: "## Archived",
    });

    expect(plan.text).not.toContain("- **0001** Live decision");
    expect(plan.text.match(/- \*\*0001\*\*/g)).toHaveLength(1);
    expect(plan.text.indexOf("- **0001** Relocated decision")).toBeGreaterThan(plan.text.indexOf("## Archived"));
  });

  it("refuses an unknown section", () => {
    expect(() =>
      planIndexEntry({ path: ".red/adr/INDEX.md", text: INDEX, number: "0003", entry: "x", section: "Nope" }),
    ).toThrow("ADR INDEX has no section: ## Nope");
  });
});

// ---------------------------------------------------------------------------
// split and merge
// ---------------------------------------------------------------------------

function draft(number: string, slug: string) {
  return {
    number,
    path: `.red/adr/${number}-${slug}.md`,
    text: `# ${number} — ${slug}\n`,
    indexEntry: `Focused ${slug}`,
    indexSection: "Active",
  };
}

describe("planSplit", () => {
  it("mints the focused records and archives the original pointing at all of them", () => {
    const plan = planSplit({
      original: { path: ".red/adr/0002-retired.md", text: ADR },
      drafts: [draft("0003", "first"), draft("0004", "second")],
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

    expect(plan.creates.map((create) => create.path)).toEqual([
      ".red/adr/0003-first.md",
      ".red/adr/0004-second.md",
    ]);
    expect(plan.archives).toHaveLength(1);
    expect(plan.archives[0]!.to).toBe(".red/adr/archive/0002-retired.md");
    expect(plan.archives[0]!.adrText).toContain("superseded-by: 0003, 0004");
    expect(plan.indexText).toContain("- **0003** Focused first");
    expect(plan.indexText).toContain("- **0004** Focused second");
    // The original's bullet moved into the Archived section, exactly once.
    expect(plan.indexText.match(/- \*\*0002\*\*/g)).toHaveLength(1);
    expect(plan.indexText.indexOf("- **0002**")).toBeGreaterThan(plan.indexText.indexOf("## Archived"));
  });

  it("refuses a split that mints fewer than two records", () => {
    expect(() =>
      planSplit({
        original: { path: ".red/adr/0002-retired.md", text: ADR },
        drafts: [draft("0003", "first")],
        indexPath: ".red/adr/INDEX.md",
        indexText: INDEX,
      }),
    ).toThrow("A split must mint at least two records");
  });
});

describe("planMerge", () => {
  const SECOND = ADR.replace("# Retired decision", "# Second decision");

  it("archives every original with the successor pointer and mints one record", () => {
    const plan = planMerge({
      originals: [
        { path: ".red/adr/0001-live.md", text: ADR },
        { path: ".red/adr/0002-retired.md", text: SECOND },
      ],
      successor: draft("0003", "consolidated"),
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

    expect(plan.archives.map((step) => step.to)).toEqual([
      ".red/adr/archive/0001-live.md",
      ".red/adr/archive/0002-retired.md",
    ]);
    for (const step of plan.archives) expect(step.adrText).toContain("superseded-by: 0003");
    expect(plan.creates).toEqual([{ path: ".red/adr/0003-consolidated.md", text: "# 0003 — consolidated\n" }]);
    expect(plan.indexText).toContain("- **0003** Focused consolidated");
  });

  it("refuses a merge of fewer than two records", () => {
    expect(() =>
      planMerge({
        originals: [{ path: ".red/adr/0001-live.md", text: ADR }],
        successor: draft("0003", "consolidated"),
        indexPath: ".red/adr/INDEX.md",
        indexText: INDEX,
      }),
    ).toThrow("A merge must consolidate at least two records");
  });
});

describe("planAbsorb", () => {
  const SECOND = ADR.replace("# Retired decision", "# Auxiliary decision");

  it("rewrites one governing ADR and archives only its auxiliaries", () => {
    const rewritten = ADR.replace(
      "Keep `apps/old/runtime.ts` as the canonical runtime.",
      "Keep `apps/new/runtime.ts` as the canonical runtime, including the auxiliary amendment.",
    );
    const plan = planAbsorb({
      governing: { path: ".red/adr/0001-live.md", text: ADR },
      rewrittenGoverningText: rewritten,
      auxiliaries: [{ path: ".red/adr/0002-retired.md", text: SECOND }],
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

    expect(plan.governing).toEqual({
      path: ".red/adr/0001-live.md",
      originalText: ADR,
      text: rewritten,
    });
    expect(plan.archives).toHaveLength(1);
    expect(plan.archives[0]!.to).toBe(".red/adr/archive/0002-retired.md");
    expect(plan.archives[0]!.adrText).toContain("superseded-by: 0001");
    expect(plan.indexText.match(/- \*\*0001\*\*/g)).toHaveLength(1);
    expect(plan.indexText.indexOf("- **0001**")).toBeLessThan(plan.indexText.indexOf("## Archived"));
    expect(plan.indexText.indexOf("- **0002**")).toBeGreaterThan(plan.indexText.indexOf("## Archived"));
  });
});

describe("applyAbsorb", () => {
  it("rewrites the governor, archives auxiliaries, then writes the INDEX once", async () => {
    const plan = planAbsorb({
      governing: { path: ".red/adr/0001-live.md", text: ADR },
      rewrittenGoverningText: ADR.replace("canonical runtime", "governing runtime"),
      auxiliaries: [{ path: ".red/adr/0002-retired.md", text: ADR }],
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });
    const events: string[] = [];

    await applyAbsorb(plan, {
      fs: {
        writeFile: async (path) => {
          events.push(`write:${path}`);
        },
      },
      git: {
        mv: async (from, to) => {
          events.push(`git-mv:${from}:${to}`);
        },
      },
    });

    expect(events).toEqual([
      "write:.red/adr/0001-live.md",
      "write:.red/adr/0002-retired.md",
      "git-mv:.red/adr/0002-retired.md:.red/adr/archive/0002-retired.md",
      "write:.red/adr/INDEX.md",
    ]);
  });

  it("rolls back the INDEX, auxiliaries, and governor when apply fails", async () => {
    const plan = planAbsorb({
      governing: { path: ".red/adr/0001-live.md", text: ADR },
      rewrittenGoverningText: ADR.replace("canonical runtime", "governing runtime"),
      auxiliaries: [{ path: ".red/adr/0002-retired.md", text: ADR }],
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });
    const events: string[] = [];

    await expect(applyAbsorb(plan, {
      fs: {
        writeFile: async (path, text) => {
          const version = path === plan.indexPath
            ? text === plan.indexText ? "planned" : "original"
            : path === plan.governing.path
              ? text === plan.governing.text ? "planned" : "original"
              : text === plan.archives[0]!.adrText ? "planned" : "original";
          events.push(`write:${path}:${version}`);
          if (path === plan.indexPath && text === plan.indexText) throw new Error("INDEX write failed");
        },
      },
      git: {
        mv: async (from, to) => {
          events.push(`git-mv:${from}:${to}`);
        },
      },
    })).rejects.toThrow("INDEX write failed");

    expect(events).toEqual([
      "write:.red/adr/0001-live.md:planned",
      "write:.red/adr/0002-retired.md:planned",
      "git-mv:.red/adr/0002-retired.md:.red/adr/archive/0002-retired.md",
      "write:.red/adr/INDEX.md:planned",
      "write:.red/adr/INDEX.md:original",
      "git-mv:.red/adr/archive/0002-retired.md:.red/adr/0002-retired.md",
      "write:.red/adr/0002-retired.md:original",
      "write:.red/adr/0001-live.md:original",
    ]);
  });
});

describe("applyComposite", () => {
  const plan = () =>
    planSplit({
      original: { path: ".red/adr/0002-retired.md", text: ADR },
      drafts: [draft("0003", "first"), draft("0004", "second")],
      indexPath: ".red/adr/INDEX.md",
      indexText: INDEX,
    });

  it("mints, archives, then writes the INDEX once", async () => {
    const writes: string[] = [];
    const moves: Array<[string, string]> = [];

    await applyComposite(plan(), {
      fs: {
        writeFile: async (path) => {
          writes.push(path);
        },
      },
      git: {
        mv: async (from, to) => {
          moves.push([from, to]);
        },
      },
    });

    expect(writes).toEqual([
      ".red/adr/0003-first.md",
      ".red/adr/0004-second.md",
      ".red/adr/0002-retired.md",
      ".red/adr/INDEX.md",
    ]);
    expect(moves).toEqual([[".red/adr/0002-retired.md", ".red/adr/archive/0002-retired.md"]]);
  });

  it("rolls the minted records and the archive move back when the INDEX write fails", async () => {
    const removed: string[] = [];
    const moves: Array<[string, string]> = [];
    let indexAttempts = 0;

    await expect(
      applyComposite(plan(), {
        fs: {
          writeFile: async (path) => {
            if (path !== ".red/adr/INDEX.md") return;
            indexAttempts += 1;
            if (indexAttempts === 1) throw new Error("index is locked");
          },
          rm: async (path) => {
            removed.push(path);
          },
        },
        git: {
          mv: async (from, to) => {
            moves.push([from, to]);
          },
        },
      }),
    ).rejects.toThrow("index is locked");

    expect(moves.at(-1)).toEqual([".red/adr/archive/0002-retired.md", ".red/adr/0002-retired.md"]);
    expect(removed).toEqual([".red/adr/0004-second.md", ".red/adr/0003-first.md"]);
    // The INDEX is restored to its pre-run text after the rollback.
    expect(indexAttempts).toBe(2);
  });
});
