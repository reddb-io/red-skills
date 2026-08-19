import { describe, expect, it } from "vitest";

import {
  memoryToolDescriptors,
  openMemoryToolContext,
  serveMemoryTool,
} from "../src/mcp-server/serve.js";

/**
 * The daemon reaches this module through a DECLARED contract
 * (`types/mcp-server-serve.d.ts`) rather than through the engine's whole type
 * surface, so a rename here would not fail a compile — it would fail on the far
 * side of a dynamic import, in the daemon, at the first memory call of the day.
 * These are the four names that contract promises.
 */
describe("the memory tool body keeps the contract the daemon imports", () => {
  it("exports the three functions the daemon's engine port calls", () => {
    expect(typeof openMemoryToolContext).toBe("function");
    expect(typeof memoryToolDescriptors).toBe("function");
    expect(typeof serveMemoryTool).toBe("function");
  });

  it("describes every tool with a name, a description and an input schema", () => {
    const tools = memoryToolDescriptors();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(typeof tool.name, JSON.stringify(tool)).toBe("string");
      expect(typeof tool.description, tool.name).toBe("string");
      expect(typeof tool.inputSchema, tool.name).toBe("object");
    }
  });

  // Every core tool `rs_memory` publishes offline must be one this body serves;
  // a session that lists a tool the daemon cannot run is a promise it breaks.
  it("serves every core tool the `rs_memory` adapter publishes without a daemon", async () => {
    const { RS_MEMORY_CORE_TOOL_NAMES, RS_MEMORY_SURFACE_TOOL } =
      await import("../src/rs-memory/index.js");
    const served = new Set(memoryToolDescriptors().map((tool) => tool.name));
    const missing = RS_MEMORY_CORE_TOOL_NAMES
      // The surface probe is the daemon's own answer about which store replied,
      // so it is deliberately not a tool the engine body knows.
      .filter((name) => name !== RS_MEMORY_SURFACE_TOOL && !served.has(name));
    expect(missing, `the memory body serves no ${missing.join(", ")}`).toEqual([]);
  });
});
