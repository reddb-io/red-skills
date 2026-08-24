// The Host companion's whole lifecycle is operable without onboard: install
// exists there, but remove and status did not exist anywhere — a unit an
// operator could create and never take back or ask about. And the public
// status.json the state store publishes had NO reader (#4365 noted it), which
// made it a dead surface: these tests pin the reader and the systemd answers.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readPublicLinkStatus } from "../src/state.js";
import {
  readRedskilledLinkUnitStatus,
  removeRedskilledLinkUnit,
  REDSKILLED_LINK_UNIT_NAME,
} from "../src/supervision.js";

describe("the Host companion unit answers remove and status", () => {
  it("remove disables, deletes the unit file and reloads — in that order", async () => {
    const calls: string[][] = [];
    const unlinked: string[] = [];
    const removal = await removeRedskilledLinkUnit({
      run: (argv) => { calls.push([...argv]); return { status: 0, stdout: "", stderr: "" }; },
      unlink: async (path) => { unlinked.push(path); },
    }, { XDG_CONFIG_HOME: "/tmp/xdg" });

    expect(removal.removed).toBe(true);
    expect(unlinked).toEqual([join("/tmp/xdg", "systemd", "user", REDSKILLED_LINK_UNIT_NAME)]);
    expect(calls).toEqual([
      ["systemctl", "--user", "disable", "--now", REDSKILLED_LINK_UNIT_NAME],
      ["systemctl", "--user", "daemon-reload"],
    ]);
  });

  it("removing a never-installed unit is success — the asked-for state already holds", async () => {
    const removal = await removeRedskilledLinkUnit({
      run: (argv) => argv.includes("disable")
        ? { status: 1, stdout: "", stderr: "not enabled" }
        : { status: 0, stdout: "", stderr: "" },
      unlink: async () => undefined,
    }, { XDG_CONFIG_HOME: "/tmp/xdg" });

    expect(removal.removed).toBe(true);
    expect(removal.detail).toContain("either way");
  });

  it("status repeats systemd's own words and says when systemd did not answer", () => {
    const answered = readRedskilledLinkUnitStatus({
      run: (argv) => ({ status: 0, stdout: argv.includes("is-active") ? "active\n" : "enabled\n", stderr: "" }),
    });
    expect(answered).toEqual({ unitName: REDSKILLED_LINK_UNIT_NAME, active: "active", enabled: "enabled" });

    const silent = readRedskilledLinkUnitStatus({
      run: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    expect(silent.active).toBeNull();
    expect(silent.enabled).toBeNull();
  });
});

describe("the published status.json finally has a reader", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("reads the projection the state store publishes", async () => {
    dir = await mkdtemp(join(tmpdir(), "link-status-"));
    const path = join(dir, "status.json");
    await writeFile(path, `${JSON.stringify({ version: 1, active_paired_device_count: 2 })}\n`);

    await expect(readPublicLinkStatus(path)).resolves.toEqual({
      version: 1,
      active_paired_device_count: 2,
    });
  });

  it("absence and garbage both read as null — nothing published, stated not guessed", async () => {
    dir = await mkdtemp(join(tmpdir(), "link-status-"));
    await expect(readPublicLinkStatus(join(dir, "status.json"))).resolves.toBeNull();

    const garbage = join(dir, "garbage.json");
    await writeFile(garbage, "not json");
    await expect(readPublicLinkStatus(garbage)).resolves.toBeNull();

    const wrongShape = join(dir, "wrong.json");
    await writeFile(wrongShape, JSON.stringify({ version: 9 }));
    await expect(readPublicLinkStatus(wrongShape)).resolves.toBeNull();
  });
});
