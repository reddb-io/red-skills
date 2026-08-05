import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const runCommandTs = resolve(here, "../src/commands/run/command.ts");

describe("afk run castle engine flip", () => {
  it("routes the drain through the red-castle worker engine instead of the dev session loop", () => {
    const source = readFileSync(runCommandTs, "utf8");

    expect(source).toContain('from "@reddb-io/red-castle/engine"');
    expect(source).toContain("runCastleWorkerDrain");
    expect(source).toContain("summary = await runCastleWorkerDrain(deps, sessionCtx)");
    expect(source).not.toContain("summary = await runSession(deps, sessionCtx)");
  });

  it("boots the Worker lane with the resolved Validation moment schedule", () => {
    const source = readFileSync(runCommandTs, "utf8");

    expect(source).toContain("await createBootCastleWorkerLaneBridge({");
    expect(source).toContain("}, readValidationMoments(config));");
  });
});
