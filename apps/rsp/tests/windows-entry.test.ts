import { describe, expect, it } from "vitest";
import { isDirectExecution } from "../src/cli.js";

describe("rsp bundle direct execution", () => {
  it("recognizes a native Windows argv path as the file URL being executed", () => {
    expect(isDirectExecution(
      "file:///C:/Users/filip/.red-skills/current/packaging/npm/dist/rsp.bundle.min.mjs",
      "C:\\Users\\filip\\.red-skills\\current\\packaging\\npm\\dist\\rsp.bundle.min.mjs",
      "win32",
    )).toBe(true);
  });

  it("decodes spaces and compares Windows paths case-insensitively", () => {
    expect(isDirectExecution(
      "file:///C:/Program%20Files/RedSkills/rsp.bundle.min.mjs",
      "c:\\program files\\redskills\\rsp.bundle.min.mjs",
      "win32",
    )).toBe(true);
  });

  it("does not mistake an imported bundle for the process entrypoint", () => {
    expect(isDirectExecution(
      "file:///C:/Users/filip/rsp.bundle.min.mjs",
      "C:\\Users\\filip\\rsp.mjs",
      "win32",
    )).toBe(false);
  });
});
