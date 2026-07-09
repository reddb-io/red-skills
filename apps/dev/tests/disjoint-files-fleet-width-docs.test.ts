import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const TO_TICKETS = "plugins/dev/skills/engineering/to-tickets/SKILL.md";
const FLEET_MD = "plugins/dev/skills/engineering/afk/fleet.md";

async function readToTickets(): Promise<string> {
  return readFile(join(ROOT, TO_TICKETS), "utf8");
}

async function readFleetMd(): Promise<string> {
  return readFile(join(ROOT, FLEET_MD), "utf8");
}

describe("disjoint-files + fleet-width-by-disjunction docs contract (#1336)", () => {
  it("to-tickets Step 3 directs the slicer to serialize file-overlapping slices with req:N", async () => {
    const skill = await readToTickets();

    expect(skill).toContain("file-disjoint");
    expect(skill).toContain("entangled");
    expect(skill).toContain("serialize");
  });

  it("to-tickets hard rules forbid marking entangled slices as parallel", async () => {
    const skill = await readToTickets();

    expect(skill).toContain("file-entanglement merge conflict");
    expect(skill).toContain("req:N` edges to serialize");
  });

  it("to-tickets vertical-slice-rules carry the parallel-implies-disjoint invariant", async () => {
    const skill = await readToTickets();

    expect(skill).toContain("Parallel slices must be file-disjoint");
    expect(skill).toContain("file-overlapping slices get");
    expect(skill).toContain("serialization edges");
  });

  it("fleet.md carries a Fleet Width by Disjunction section", async () => {
    const fleet = await readFleetMd();

    expect(fleet).toContain("## Fleet Width by Disjunction");
    expect(fleet).toContain("degree of disjunction");
  });

  it("fleet.md names fleet 1 as the correct width for fully entangled refactors", async () => {
    const fleet = await readFleetMd();

    expect(fleet).toContain("fleet 1");
    expect(fleet).toContain("entangled");
    expect(fleet).toContain("fleet width = degree of disjunction");
  });

  it("fleet.md cross-references to-tickets as the responsible skill for req:N edges", async () => {
    const fleet = await readFleetMd();

    expect(fleet).toContain("/to-tickets");
    expect(fleet).toContain("req:N` edges");
  });
});
