import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const runCommandTs = resolve(here, "../src/commands/run/command.ts");

describe("afk run castle engine flip", () => {
  it("routes the drain through the red-castle worker engine instead of the dev session loop", () => {
    const source = readFileSync(runCommandTs, "utf8");

    expect(source).toContain('from "@reddb-io/worker/engine"');
    expect(source).toContain("runCastleWorkerDrain");
    expect(source).toContain("summary = await runCastleWorkerDrain(deps, sessionCtx)");
    expect(source).not.toContain("summary = await runSession(deps, sessionCtx)");
  });

  it("boots the Worker lane with the resolved Validation moment schedule and its gate verdict", () => {
    const source = readFileSync(runCommandTs, "utf8");

    expect(source).toContain("await createBootCastleWorkerLaneBridge({");
    // The audit rides along, not just the schedule: an empty schedule means
    // one thing when the directory opted in and another when the gate
    // discarded the whole block, and only the audit can tell them apart
    // (#3939). Loading it plainly here would silently re-lose that.
    expect(source).toContain("}, readValidationMoments(configAudit.values), configAudit);");
    expect(source).toContain("auditConfigLoad(paths.configPath");
  });
});
