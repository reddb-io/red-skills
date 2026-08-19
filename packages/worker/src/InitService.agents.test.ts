import { describe, expect, it } from "vitest";
import { listAgents, getAgent } from "./InitService.js";

describe("Agent registry", () => {
  it("listAgents returns at least claude-code", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "claude-code")).toBe(true);
  });

  it("getAgent returns claude-code entry with expected fields", () => {
    const agent = getAgent("claude-code");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("claude-code");
    expect(agent!.defaultModel).toBe("claude-opus-4-8");
    expect(agent!.factoryImport).toBe("claudeCode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
  });

  it("getAgent returns undefined for unknown agent", () => {
    expect(getAgent("nonexistent")).toBeUndefined();
  });

  it("listAgents includes pi", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "pi")).toBe(true);
  });

  it("getAgent returns pi entry with expected fields", () => {
    const agent = getAgent("pi");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("pi");
    expect(agent!.defaultModel).toBe("claude-sonnet-4-6");
    expect(agent!.factoryImport).toBe("pi");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain(
      "@mariozechner/pi-coding-agent",
    );
  });

  it("listAgents includes codex", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "codex")).toBe(true);
  });

  it("getAgent returns codex entry with expected fields", () => {
    const agent = getAgent("codex");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("codex");
    expect(agent!.defaultModel).toBe("gpt-5.4");
    expect(agent!.factoryImport).toBe("codex");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("@openai/codex");
  });

  it("listAgents includes opencode", () => {
    const agents = listAgents();
    expect(agents.some((a) => a.name === "opencode")).toBe(true);
  });

  it("getAgent returns opencode entry with expected fields", () => {
    const agent = getAgent("opencode");
    expect(agent).toBeDefined();
    expect(agent!.name).toBe("opencode");
    expect(agent!.defaultModel).toBe("opencode/big-pickle");
    expect(agent!.factoryImport).toBe("opencode");
    expect(agent!.dockerfileTemplate).toContain("FROM");
    expect(agent!.dockerfileTemplate).toContain("opencode-ai");
  });
});
