import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { applyDangerPosture } from "./posture.js";
import type { CastleMcpTool } from "./tool.js";

function safeTool(): CastleMcpTool {
  return {
    name: "safe_op",
    title: "Safe operation",
    description: "A read-only tool with no danger class.",
    inputSchema: { id: z.string() },
    invoke: vi.fn(async () => ({ ok: true })),
  };
}

function dangerousTool(): CastleMcpTool {
  return {
    name: "dangerous_op",
    title: "Dangerous operation",
    description: "MUTATING: does something irreversible.",
    dangerClass: "mutating",
    inputSchema: { branch: z.string() },
    invoke: vi.fn(async (input) => ({ branch: input["branch"], done: true })),
  };
}

describe("applyDangerPosture", () => {
  describe("allow posture (default)", () => {
    it("returns the same tool array instance unchanged", () => {
      const tools = [safeTool(), dangerousTool()];
      const result = applyDangerPosture(tools, "allow");
      expect(result).toBe(tools);
    });

    it("executes dangerous tools without restriction", async () => {
      const tools = applyDangerPosture([dangerousTool()], "allow");
      await expect(
        tools[0]!.invoke({ branch: "afk/w80UR/1234" }),
      ).resolves.toEqual({ branch: "afk/w80UR/1234", done: true });
    });
  });

  describe("deny posture", () => {
    it("returns a structured refusal for dangerous tools", async () => {
      const tools = applyDangerPosture([dangerousTool()], "deny");
      await expect(tools[0]!.invoke({ branch: "afk/w80UR/1234" })).resolves.toEqual({
        refused: true,
        posture: "deny",
        action: "dangerous_op",
        reason: expect.stringContaining("denied"),
        repair: "none",
        repair_reason: "the configured posture deliberately forbids this tool",
      });
    });

    it("never calls the underlying invoke for dangerous tools", async () => {
      const tool = dangerousTool();
      const tools = applyDangerPosture([tool], "deny");
      await tools[0]!.invoke({ branch: "afk/w80UR/1234" });
      expect(tool.invoke).not.toHaveBeenCalled();
    });

    it("passes safe tools through unchanged", async () => {
      const tool = safeTool();
      const tools = applyDangerPosture([tool], "deny");
      await tools[0]!.invoke({ id: "abc" });
      expect(tool.invoke).toHaveBeenCalledWith({ id: "abc" });
    });

    it("does not add confirmation to the schema of dangerous tools", () => {
      const tools = applyDangerPosture([dangerousTool()], "deny");
      expect(Object.keys(tools[0]!.inputSchema)).not.toContain("confirmation");
    });
  });

  describe("confirm posture", () => {
    it("returns a structured refusal when confirmation is absent", async () => {
      const tools = applyDangerPosture([dangerousTool()], "confirm");
      await expect(
        tools[0]!.invoke({ branch: "afk/w80UR/1234" }),
      ).resolves.toEqual({
        refused: true,
        posture: "confirm",
        action: "dangerous_op",
        reason: expect.stringContaining("confirmation"),
        repair: {
          tool: "dangerous_op",
          args: { branch: "afk/w80UR/1234", confirmation: true },
          why: "retry the same operation with explicit confirmation",
        },
      });
    });

    it("returns a structured refusal when confirmation is explicitly false", async () => {
      const tools = applyDangerPosture([dangerousTool()], "confirm");
      const result = await tools[0]!.invoke({
        branch: "afk/w80UR/1234",
        confirmation: false,
      });
      expect(result).toMatchObject({ refused: true, posture: "confirm" });
    });

    it("executes when confirmation is true and strips the confirmation key", async () => {
      const tool = dangerousTool();
      const tools = applyDangerPosture([tool], "confirm");
      const result = await tools[0]!.invoke({
        branch: "afk/w80UR/1234",
        confirmation: true,
      });
      expect(result).toEqual({ branch: "afk/w80UR/1234", done: true });
      expect(tool.invoke).toHaveBeenCalledWith({ branch: "afk/w80UR/1234" });
    });

    it("never calls the underlying invoke without confirmation", async () => {
      const tool = dangerousTool();
      const tools = applyDangerPosture([tool], "confirm");
      await tools[0]!.invoke({ branch: "afk/w80UR/1234" });
      expect(tool.invoke).not.toHaveBeenCalled();
    });

    it("adds confirmation to the input schema of dangerous tools", () => {
      const tools = applyDangerPosture([dangerousTool()], "confirm");
      expect(Object.keys(tools[0]!.inputSchema)).toContain("confirmation");
    });

    it("preserves original schema keys alongside confirmation", () => {
      const tools = applyDangerPosture([dangerousTool()], "confirm");
      expect(Object.keys(tools[0]!.inputSchema)).toContain("branch");
    });

    it("passes safe tools through without adding confirmation", async () => {
      const tool = safeTool();
      const tools = applyDangerPosture([tool], "confirm");
      await tools[0]!.invoke({ id: "abc" });
      expect(tool.invoke).toHaveBeenCalledWith({ id: "abc" });
      expect(Object.keys(tools[0]!.inputSchema)).not.toContain("confirmation");
    });
  });

  describe("mixed tool lists", () => {
    it("deny posture only intercepts dangerous tools, safe tools execute normally", async () => {
      const safe = safeTool();
      const dangerous = dangerousTool();
      const tools = applyDangerPosture([safe, dangerous], "deny");

      await tools[0]!.invoke({ id: "x" });
      expect(safe.invoke).toHaveBeenCalledWith({ id: "x" });

      const result = await tools[1]!.invoke({ branch: "main" });
      expect(result).toMatchObject({ refused: true });
      expect(dangerous.invoke).not.toHaveBeenCalled();
    });

    it("confirm posture only intercepts dangerous tools, safe tools execute normally", async () => {
      const safe = safeTool();
      const dangerous = dangerousTool();
      const tools = applyDangerPosture([safe, dangerous], "confirm");

      await tools[0]!.invoke({ id: "x" });
      expect(safe.invoke).toHaveBeenCalledWith({ id: "x" });

      const refusedResult = await tools[1]!.invoke({ branch: "main" });
      expect(refusedResult).toMatchObject({ refused: true });

      const okResult = await tools[1]!.invoke({ branch: "main", confirmation: true });
      expect(okResult).toEqual({ branch: "main", done: true });
    });
  });
});
