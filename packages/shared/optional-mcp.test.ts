import { describe, expect, it } from "vitest";
import {
  OPTIONAL_MCP_SERVERS,
  optedInMcpServers,
  pluginMcpDeclaration,
} from "./optional-mcp.js";

/** What memory's `.mcp.json` ships on its own. */
const MEMORY_DECLARED = { rs_memory: { command: "sh", args: ["-c", "…"] } };
const BRAIN_DECLARED = { brain: { command: "sh", args: ["-c", "…"] } };

const OPTED_IN = { "plugins.red-ui.enabled": "true" };

describe("red-ui is composed from config, never shipped enabled (ADR 0147 §4)", () => {
  it("adds nothing to memory when the project never asked", () => {
    expect(optedInMcpServers("memory", {})).toEqual({});
    expect(Object.keys(pluginMcpDeclaration("memory", MEMORY_DECLARED, {}))).toEqual(["rs_memory"]);
  });

  it("adds the viewer to the memory declaration when the project opts in", () => {
    const declaration = pluginMcpDeclaration("memory", MEMORY_DECLARED, OPTED_IN);
    expect(Object.keys(declaration).sort()).toEqual(["red-ui", "rs_memory"]);
    expect(declaration["red-ui"]).toEqual({
      command: "npx",
      args: ["-y", "@reddb-io/ui@latest", "mcp", "--stdio"],
      env: { RED_UI_APP_URL: "https://ui.reddb.io" },
    });
  });

  it("adds the same viewer to the brain declaration from the same one gate", () => {
    const declaration = pluginMcpDeclaration("brain", BRAIN_DECLARED, OPTED_IN);
    expect(Object.keys(declaration).sort()).toEqual(["brain", "red-ui"]);
  });

  it("reads the gate strictly, so a truthy-looking value is still off", () => {
    // ADR 0067's rule: only the literal `true` opts in. `yes`, `1` and an empty
    // value are how a half-finished config edit looks, not how consent looks.
    for (const value of ["yes", "1", "TRUE", ""]) {
      expect(optedInMcpServers("memory", { "plugins.red-ui.enabled": value })).toEqual({});
    }
  });

  it("offers dev nothing to opt into", () => {
    expect(optedInMcpServers("dev", OPTED_IN)).toEqual({});
    expect(OPTIONAL_MCP_SERVERS.dev).toBeUndefined();
  });

  it("lets a shipped entry win its own name back", () => {
    const owned = { "red-ui": { command: "node", args: ["local-viewer.mjs"] } };
    expect(pluginMcpDeclaration("memory", owned, OPTED_IN)["red-ui"]).toEqual(owned["red-ui"]);
  });
});
