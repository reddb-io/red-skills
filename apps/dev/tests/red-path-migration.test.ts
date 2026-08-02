import { describe, expect, it } from "vitest";
import {
  migrationActionFor,
  planDevDurablePathMigration,
  supervisorLogMigration,
} from "../src/core/red-path-migration.js";

const ROOT = "/repo";

describe("planDevDurablePathMigration", () => {
  const plan = planDevDurablePathMigration(ROOT);
  const byId = new Map(plan.map((e) => [e.id, e]));

  it("maps durable history to state/castle and live supervisor artifacts to tmp/supervisors/default", () => {
    expect(byId.get("afk-supervisor.state.json")).toMatchObject({
      legacy: "/repo/.red/tmp/afk-supervisor.state.json",
      current: "/repo/.red/tmp/supervisors/default/state.toon",
      kind: "file",
    });
    expect(byId.get("afk-supervisor.pid")?.current).toBe("/repo/.red/tmp/supervisors/default/afk-supervisor.pid");
    expect(byId.get("afk-supervisor-boot.pid")?.current).toBe("/repo/.red/tmp/supervisors/default/afk-supervisor-boot.pid");
    expect(byId.get("afk-supervisor.stop")?.current).toBe("/repo/.red/tmp/supervisors/default/afk-supervisor.stop");
    expect(byId.get("afk-supervisor.restarts.json")?.current).toBe(
      "/repo/.red/tmp/supervisors/default/restarts.toon",
    );
    expect(byId.get("monitor-log-cursors.json")?.current).toBe("/repo/.red/tmp/supervisors/default/monitor-log-cursors.toon");
    expect(byId.get("afk-history.toonl")).toMatchObject({
      legacy: "/repo/.red/state/afk-history.toonl",
      current: "/repo/.red/state/castle/history.toonl",
      kind: "file",
    });
  });

  it("relocates runner circuit directories into the supervisor tmp lane", () => {
    expect(byId.get("runner-circuit")).toMatchObject({
      legacy: "/repo/.red/tmp/runner-circuit",
      current: "/repo/.red/tmp/supervisors/default/runner-circuit",
      kind: "dir",
    });
    expect(byId.get("state/afk/runner-circuit")).toMatchObject({
      legacy: "/repo/.red/state/afk/runner-circuit",
      current: "/repo/.red/tmp/supervisors/default/runner-circuit",
      kind: "dir",
    });
  });

  it("retires the legacy state/afk supervisor lane into tmp/supervisors/default", () => {
    expect(byId.get("state/afk/afk-supervisor.pid")).toMatchObject({
      legacy: "/repo/.red/state/afk/afk-supervisor.pid",
      current: "/repo/.red/tmp/supervisors/default/afk-supervisor.pid",
      kind: "file",
    });
    expect(byId.get("state/afk/afk-supervisor.log.toonl")).toMatchObject({
      legacy: "/repo/.red/state/afk/afk-supervisor.log.toonl",
      current: "/repo/.red/tmp/supervisors/default/supervisor.log.toonl",
      kind: "file",
    });
    expect(byId.has("state/afk/afk-supervisor.log")).toBe(false);
  });

  it("repairs live supervisor artifacts already stranded in state/castle", () => {
    expect(byId.get("state/castle/afk-supervisor.pid")).toMatchObject({
      legacy: "/repo/.red/state/castle/afk-supervisor.pid",
      current: "/repo/.red/tmp/supervisors/default/afk-supervisor.pid",
      kind: "file",
    });
    expect(byId.get("state/castle/afk-supervisor.log.toonl")).toMatchObject({
      legacy: "/repo/.red/state/castle/afk-supervisor.log.toonl",
      current: "/repo/.red/tmp/supervisors/default/supervisor.log.toonl",
      kind: "file",
    });
    expect(byId.get("state/castle/monitor-log-cursors.json")?.current).toBe(
      "/repo/.red/tmp/supervisors/default/monitor-log-cursors.toon",
    );
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

  it("never sources from outside .red/tmp or .red/state nor targets outside state or supervisor tmp lanes", () => {
    for (const entry of plan) {
      expect(entry.legacy.startsWith("/repo/.red/tmp/") || entry.legacy.startsWith("/repo/.red/state/")).toBe(true);
      expect(
        entry.current.startsWith("/repo/.red/state") ||
        entry.current.startsWith("/repo/.red/tmp/supervisors/default/"),
      ).toBe(true);
    }
  });
});

describe("supervisorLogMigration", () => {
  it("globs the structured supervisor firehose from tmp into tmp/supervisors/default", () => {
    expect(supervisorLogMigration(ROOT)).toEqual({
      legacyDir: "/repo/.red/tmp",
      currentDir: "/repo/.red/tmp/supervisors/default",
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
