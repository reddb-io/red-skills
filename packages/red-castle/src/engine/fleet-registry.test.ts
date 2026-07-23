import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEnginePaths } from "./paths.js";
import {
  DEFAULT_FLEET_NAME,
  FleetRegistryValidationError,
  fleetRegistryPath,
  isValidFleetName,
  parseFleetSelector,
  readFleetProfile,
  readFleetProfiles,
  removeFleetProfile,
  resolveFleetName,
  upsertFleetProfile,
  validateFleetProfile,
  type FleetProfile,
} from "./fleet-registry.js";

async function registry(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "castle-fleets-"));
  return fleetRegistryPath(createEnginePaths(join(dir, ".red")));
}

const FULL: FleetProfile = {
  name: "spec-drain",
  runner: "codex",
  selector: {
    spec: 2303,
    lane: "go",
    label: "priority:high",
    issues: [11, 12],
    tags: ["backend", "infra"],
    user: "octocat",
  },
  config: { target: 4, shrinkMode: "hard-kill", alternate: true },
  base: "main",
};

describe("fleet registry paths", () => {
  it("puts the registry in the castle state root", () => {
    const paths = createEnginePaths("/repo/.red");
    expect(fleetRegistryPath(paths)).toBe("/repo/.red/state/castle/fleets.toonl");
  });

  it("gives each named fleet its own supervisor runtime lane", () => {
    const paths = createEnginePaths("/repo/.red");
    expect(paths.fleet("alpha")).toBe("/repo/.red/tmp/supervisors/alpha");
    expect(paths.fleet("beta")).toBe("/repo/.red/tmp/supervisors/beta");
    expect(paths.fleet("alpha")).not.toBe(paths.fleet("beta"));
  });
});

describe("fleet names", () => {
  it("defaults an omitted name and rejects unsafe ones", () => {
    expect(resolveFleetName()).toBe(DEFAULT_FLEET_NAME);
    expect(resolveFleetName("")).toBe(DEFAULT_FLEET_NAME);
    expect(resolveFleetName("alpha-1")).toBe("alpha-1");
    for (const bad of ["../escape", "a/b", "..", "Alpha", "-lead", "s1234"]) {
      expect(isValidFleetName(bad), bad).toBe(false);
      expect(() => resolveFleetName(bad), bad).toThrow(FleetRegistryValidationError);
    }
  });
});

describe("fleet selector parsing", () => {
  it("accepts tags and user facets, deduping tag values", () => {
    expect(
      parseFleetSelector({ tags: ["backend", "infra", "backend"], user: "octocat" }),
    ).toEqual({ tags: ["backend", "infra"], user: "octocat" });
    // "@me" is a legitimate stored value — the consumer resolves it pre-persist.
    expect(parseFleetSelector({ user: "@me" })).toEqual({ user: "@me" });
  });

  it("rejects malformed tags: non-arrays, empties, prefixes, and non-label shapes", () => {
    for (const bad of [
      "backend",
      [],
      [""],
      ["tag:backend"],
      ["Backend Stuff"],
      [42],
    ]) {
      expect(() => parseFleetSelector({ tags: bad }), JSON.stringify(bad)).toThrow(
        FleetRegistryValidationError,
      );
    }
    expect(() => parseFleetSelector({ user: "" })).toThrow(
      FleetRegistryValidationError,
    );
  });
});

describe("fleet profile round-trip", () => {
  it("round-trips runner + selector + config + base through the registry", async () => {
    const path = await registry();
    await upsertFleetProfile(path, FULL);
    expect(await readFleetProfile(path, "spec-drain")).toEqual(FULL);
    expect(await readFleetProfiles(path)).toEqual([FULL]);
  });

  it("stores the registry as TOONL, never JSON", async () => {
    const path = await registry();
    await upsertFleetProfile(path, FULL);
    const bytes = await readFile(path, "utf8");
    expect(() => JSON.parse(bytes)).toThrow();
    expect(bytes.trimEnd().split("\n").length).toBeGreaterThan(0);
  });

  it("keeps several named fleets side by side", async () => {
    const path = await registry();
    await upsertFleetProfile(path, { name: "alpha", runner: "claude" });
    await upsertFleetProfile(path, { name: "beta", runner: "codex", selector: { spec: 7 } });
    expect((await readFleetProfiles(path)).map((p) => p.name)).toEqual(["alpha", "beta"]);
  });

  it("folds an edit last-write-wins without losing the listing slot", async () => {
    const path = await registry();
    await upsertFleetProfile(path, { name: "alpha", runner: "claude" });
    await upsertFleetProfile(path, { name: "beta", runner: "codex" });
    await upsertFleetProfile(path, { name: "alpha", runner: "codex", base: "next" });
    const profiles = await readFleetProfiles(path);
    expect(profiles.map((p) => p.name)).toEqual(["alpha", "beta"]);
    expect(profiles[0]).toEqual({ name: "alpha", runner: "codex", base: "next" });
  });

  it("tombstones a removal and reports whether one was live", async () => {
    const path = await registry();
    await upsertFleetProfile(path, { name: "alpha", runner: "claude" });
    expect(await removeFleetProfile(path, "alpha")).toBe(true);
    expect(await readFleetProfile(path, "alpha")).toBeUndefined();
    expect(await readFleetProfiles(path)).toEqual([]);
    expect(await removeFleetProfile(path, "alpha")).toBe(false);
  });

  it("reads a missing registry as empty", async () => {
    expect(await readFleetProfiles(await registry())).toEqual([]);
  });

  it("rejects a malformed profile", () => {
    expect(() => validateFleetProfile({ name: "alpha" } as FleetProfile)).toThrow(
      FleetRegistryValidationError,
    );
    expect(() =>
      validateFleetProfile({ name: "alpha", runner: "claude", selector: { spec: 0 } }),
    ).toThrow(FleetRegistryValidationError);
    expect(() =>
      validateFleetProfile({
        name: "alpha",
        runner: "claude",
        config: { nested: { a: 1 } } as never,
      }),
    ).toThrow(FleetRegistryValidationError);
  });
});
