import { describe, expect, it } from "vitest";
import {
  migrationActionFor,
  planDevDurablePathMigration,
  supervisorLogMigration,
} from "./red-path-migration.js";

const ROOT = "/repo";

describe("planDevDurablePathMigration", () => {
  const plan = planDevDurablePathMigration(ROOT);
  const byId = new Map(plan.map((e) => [e.id, e]));

  it("maps every durable artifact from .red/tmp to its state-tier home", () => {
    expect(byId.get("afk-supervisor.state.json")).toMatchObject({
      legacy: "/repo/.red/tmp/afk-supervisor.state.json",
      current: "/repo/.red/state/castle/afk-supervisor.state.json",
      kind: "file",
    });
    expect(byId.get("afk-supervisor.pid")?.current).toBe("/repo/.red/state/castle/afk-supervisor.pid");
    expect(byId.get("afk-supervisor.stop")?.current).toBe("/repo/.red/state/castle/afk-supervisor.stop");
    expect(byId.get("afk-supervisor.restarts.json")?.current).toBe(
      "/repo/.red/state/castle/afk-supervisor.restarts.json",
    );
    expect(byId.get("monitor-log-cursors.json")?.current).toBe("/repo/.red/state/castle/monitor-log-cursors.json");
    expect(byId.get("afk-history.toonl")).toMatchObject({
      legacy: "/repo/.red/state/afk-history.toonl",
      current: "/repo/.red/state/castle/history.toonl",
      kind: "file",
    });
  });

  it("relocates runner circuit directories into state/castle", () => {
    expect(byId.get("runner-circuit")).toMatchObject({
      legacy: "/repo/.red/tmp/runner-circuit",
      current: "/repo/.red/state/castle/runner-circuit",
      kind: "dir",
    });
    expect(byId.get("state/afk/runner-circuit")).toMatchObject({
      legacy: "/repo/.red/state/afk/runner-circuit",
      current: "/repo/.red/state/castle/runner-circuit",
      kind: "dir",
    });
  });

  it("retires the legacy state/afk supervisor lane into state/castle", () => {
    expect(byId.get("state/afk/afk-supervisor.pid")).toMatchObject({
      legacy: "/repo/.red/state/afk/afk-supervisor.pid",
      current: "/repo/.red/state/castle/afk-supervisor.pid",
      kind: "file",
    });
    expect(byId.get("state/afk/afk-supervisor.log.toonl")).toMatchObject({
      legacy: "/repo/.red/state/afk/afk-supervisor.log.toonl",
      current: "/repo/.red/state/castle/afk-supervisor.log.toonl",
      kind: "file",
    });
  });

  it("relocates statusline caches into the statusline state lane", () => {
    expect(byId.get("statusline-cache.json")?.current).toBe("/repo/.red/state/statusline/statusline-cache.toon");
    expect(byId.get("statusline-repo-cache.json")?.current).toBe(
      "/repo/.red/state/statusline/statusline-repo-cache.toon",
    );
    expect(byId.get("state/statusline-cache.json")).toMatchObject({
      legacy: "/repo/.red/state/statusline/statusline-cache.json",
      current: "/repo/.red/state/statusline/statusline-cache.toon",
    });
    expect(byId.get("state/statusline-repo-cache.json")).toMatchObject({
      legacy: "/repo/.red/state/statusline/statusline-repo-cache.json",
      current: "/repo/.red/state/statusline/statusline-repo-cache.toon",
    });
  });

  it("does not migrate the branch lock (its shell writer still owns tmp)", () => {
    expect(byId.has("branch-lock.yaml")).toBe(false);
  });

  it("never sources from outside .red/tmp or .red/state nor targets outside .red/state", () => {
    for (const entry of plan) {
      expect(entry.legacy.startsWith("/repo/.red/tmp/") || entry.legacy.startsWith("/repo/.red/state/")).toBe(true);
      expect(entry.current.startsWith("/repo/.red/state")).toBe(true);
    }
  });
});

describe("supervisorLogMigration", () => {
  it("globs the rotated supervisor logs from tmp into state/castle", () => {
    expect(supervisorLogMigration(ROOT)).toEqual({
      legacyDir: "/repo/.red/tmp",
      currentDir: "/repo/.red/state/castle",
      logPrefix: "afk-supervisor.log",
    });
  });
});

describe("migrationActionFor", () => {
  it("moves when only the legacy copy exists", () => {
    expect(migrationActionFor(true, false)).toBe("move");
  });

  it("is ambiguous (delete nothing) when both exist", () => {
    expect(migrationActionFor(true, true)).toBe("ambiguous");
  });

  it("is a no-op when the legacy copy is gone (idempotent second boot)", () => {
    expect(migrationActionFor(false, false)).toBe("absent");
    expect(migrationActionFor(false, true)).toBe("absent");
  });
});
