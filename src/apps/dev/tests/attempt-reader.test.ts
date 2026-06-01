import { describe, expect, it } from "vitest";
import { detectSentinelInText, detectSentinelLine } from "../src/core/attempt-reader.js";

describe("attempt reader sentinel detection", () => {
  it("normalizes the canonical promise outcomes", () => {
    expect(detectSentinelLine("<promise>DONE</promise>")).toEqual({ kind: "done", raw: "<promise>DONE</promise>" });
    expect(detectSentinelLine("x <promise>BLOCKED</promise> y")?.kind).toBe("blocked");
    expect(detectSentinelLine("<promise>NO MORE TASKS</promise>")?.kind).toBe("no_more_tasks");
  });

  it("finds the first authored sentinel in streamed text", () => {
    const text = "working\nstill working\n<promise>DONE</promise>\ntrailing daemon noise";
    expect(detectSentinelInText(text)?.kind).toBe("done");
  });

  it("returns null when EOF arrives without a sentinel", () => {
    expect(detectSentinelInText("runner crashed before promise")).toBeNull();
  });
});
