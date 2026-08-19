import { describe, expect, it } from "vitest";
import type { MemoryConfig } from "../src/config.js";
import { shouldUseResidentMemory } from "../src/resident-memory.js";

const ROOT = "/repo";

function graphConfig(storePath?: string): MemoryConfig {
  return { mode: "graph", storePath } as MemoryConfig;
}

describe("shouldUseResidentMemory", () => {
  it("uses the resident for the canonical state-tier shared store", () => {
    expect(shouldUseResidentMemory(ROOT, graphConfig(".red/state/red-skills.rdb"))).toBe(true);
    expect(shouldUseResidentMemory(ROOT, graphConfig("/repo/.red/state/red-skills.rdb"))).toBe(true);
  });

  it("rejects the legacy tmp-tier shared store with a migration path", () => {
    expect(() => shouldUseResidentMemory(ROOT, graphConfig(".red/tmp/red-skills.rdb"))).toThrow(
      "Run `rsp setup` to migrate it to .red/state/red-skills.rdb",
    );
    expect(() => shouldUseResidentMemory(ROOT, graphConfig("/repo/.red/tmp/red-skills.rdb"))).toThrow(
      "Run `rsp setup` to migrate it to .red/state/red-skills.rdb",
    );
  });

  it("does not use the resident for a private graph store or in markdown-only mode", () => {
    expect(shouldUseResidentMemory(ROOT, graphConfig(".red/memory/graph.rdb"))).toBe(false);
    expect(shouldUseResidentMemory(ROOT, { mode: "markdown-only", storePath: ".red/state/red-skills.rdb" } as MemoryConfig)).toBe(false);
  });
});
