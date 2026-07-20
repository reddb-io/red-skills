import { describe, expect, it } from "vitest";
import {
  applyArchiveMove,
  applyIndexArchive,
  applyStalePathFix,
  applyStatusAndSuccessor,
  planArchiveMove,
  planIndexArchive,
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
      adrText: ADR.replace(
        "## Status\n\nAccepted.",
        "## Status\n\nSuperseded by ADR 0113.\n\nsuperseded-by: 0113",
      ),
      indexPath: ".red/adr/INDEX.md",
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
