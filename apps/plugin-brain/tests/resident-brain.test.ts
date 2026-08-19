import { describe, expect, it } from "vitest";
import type { ResolvedBrainConfig } from "@reddb-io/brain-store/config.js";
import { SHARED_RSP_STORE_PATH, shouldUseResidentBrain } from "../src/resident-brain.js";

const ROOT = "/repo";

function config(connectionString: string): ResolvedBrainConfig {
  return { rootDir: ROOT, configPath: "", connectionString, rawConnectionString: connectionString };
}

describe("shouldUseResidentBrain", () => {
  it("pins the shared store constant to the state tier", () => {
    expect(SHARED_RSP_STORE_PATH).toBe(".red/state/red-skills.rdb");
  });

  it("uses the resident for the canonical state-tier shared store", () => {
    expect(shouldUseResidentBrain(config("file:///repo/.red/state/red-skills.rdb"))).toBe(true);
  });

  it("rejects the legacy tmp-tier store with a migration path", () => {
    expect(() => shouldUseResidentBrain(config("file:///repo/.red/tmp/red-skills.rdb"))).toThrow(
      "Run `rsp setup` to migrate it to .red/state/red-skills.rdb",
    );
  });

  it("does not use the resident for a private brain store", () => {
    expect(shouldUseResidentBrain(config("file:///repo/.red/brain/brain.rdb"))).toBe(false);
  });
});
