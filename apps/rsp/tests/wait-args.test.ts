import { describe, expect, it } from "vitest";
import { parseWaitArgs } from "../src/wait/args.js";

describe("rsp wait GitHub routing arguments", () => {
  it("recognizes one Actions job as a first-class wait target", async () => {
    await expect(parseWaitArgs(["wait", "job", "93918599356"])).resolves.toMatchObject({
      kind: "job",
      target: "93918599356",
      options: { format: "toon" },
    });
  });

  it("distinguishes waiting for an existing release from waiting for the next release", async () => {
    await expect(parseWaitArgs(["wait", "release", "--tag", "v0.23.5", "--existing"])).resolves.toMatchObject({
      kind: "release",
      tagGlob: "v0.23.5",
      existing: true,
    });
  });
});
