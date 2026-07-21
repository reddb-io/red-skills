import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { beforeEach, describe, expect, it } from "vitest";
import { managerCommand } from "../src/commands/manager.js";
import { readEffort } from "../src/core/manager/effort-store.js";

let root: string;
let out: string[];
let err: string[];

function deps(): Parameters<typeof managerCommand>[1] {
  return {
    root,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
}

function brief(): Record<string, unknown> {
  return decode(out.join("")) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-s3-"));
  out = [];
  err = [];
});

describe("manager route — records the ask-red route in an effort", () => {
  it("stores the route and returns an updated brief", async () => {
    await managerCommand(["write a spec for the auth feature"], deps());
    const effortId = String(brief().effort_id);
    out = [];

    expect(await managerCommand(["route", effortId, "to-spec"], deps())).toBe(0);
    const stored = await readEffort(root, effortId);
    expect(stored?.route).toBe("to-spec");
    expect(brief().route).toBe("to-spec");
  });

  it("bumps the generation when recording a route", async () => {
    await managerCommand(["an intent"], deps());
    const effortId = String(brief().effort_id);
    out = [];

    await managerCommand(["route", effortId, "afk"], deps());
    const stored = await readEffort(root, effortId);
    expect(stored?.generation).toBe(2);
  });

  it("accepts any skill name from ask-red's inventory", async () => {
    await managerCommand(["an intent"], deps());
    const id = String(brief().effort_id);
    out = [];

    expect(await managerCommand(["route", id, "afk"], deps())).toBe(0);
    expect((await readEffort(root, id))?.route).toBe("afk");
  });

  it("returns 1 and names the id for an unknown effort", async () => {
    expect(
      await managerCommand(["route", "eff_zzzzzzzzzzzzzzzzzzzzzzzzzz", "to-spec"], deps()),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/eff_zzzz/);
  });

  it("returns 2 with usage when the skill argument is missing", async () => {
    await managerCommand(["an intent"], deps());
    const id = String(brief().effort_id);
    out = [];

    expect(await managerCommand(["route", id], deps())).toBe(2);
    expect(err.join("")).toMatch(/usage/i);
  });

  it("returns 2 with usage when both effort and skill are missing", async () => {
    expect(await managerCommand(["route"], deps())).toBe(2);
    expect(err.join("")).toMatch(/usage/i);
  });
});

describe("manager artifact — captures artifact references from inline skill runs", () => {
  it("stores the artifact reference and returns an updated brief", async () => {
    await managerCommand(["spec the auth feature"], deps());
    const effortId = String(brief().effort_id);
    out = [];

    const ref = "https://github.com/reddb-io/red-skills/issues/999";
    expect(await managerCommand(["artifact", effortId, ref], deps())).toBe(0);
    const stored = await readEffort(root, effortId);
    expect(stored?.artifact_refs).toEqual([ref]);
    expect(brief().artifact_refs).toEqual([ref]);
  });

  it("accumulates multiple artifact references without overwriting earlier ones", async () => {
    await managerCommand(["an effort"], deps());
    const id = String(brief().effort_id);
    out = [];

    await managerCommand(
      ["artifact", id, "https://github.com/reddb-io/red-skills/issues/1"],
      deps(),
    );
    out = [];
    await managerCommand(
      ["artifact", id, "https://github.com/reddb-io/red-skills/issues/2"],
      deps(),
    );

    const stored = await readEffort(root, id);
    expect(stored?.artifact_refs).toEqual([
      "https://github.com/reddb-io/red-skills/issues/1",
      "https://github.com/reddb-io/red-skills/issues/2",
    ]);
    expect(brief().artifact_refs).toEqual([
      "https://github.com/reddb-io/red-skills/issues/1",
      "https://github.com/reddb-io/red-skills/issues/2",
    ]);
  });

  it("returns 1 and names the id for an unknown effort", async () => {
    expect(
      await managerCommand(
        ["artifact", "eff_zzzzzzzzzzzzzzzzzzzzzzzzzz", "https://github.com/x"],
        deps(),
      ),
    ).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/eff_zzzz/);
  });

  it("returns 2 with usage when the ref argument is missing", async () => {
    await managerCommand(["an intent"], deps());
    const id = String(brief().effort_id);
    out = [];

    expect(await managerCommand(["artifact", id], deps())).toBe(2);
    expect(err.join("")).toMatch(/usage/i);
  });

  it("returns 2 with usage when both effort and ref are missing", async () => {
    expect(await managerCommand(["artifact"], deps())).toBe(2);
    expect(err.join("")).toMatch(/usage/i);
  });
});

describe("brief — route and artifact_refs appear only when present", () => {
  it("omits route and artifact_refs from a fresh effort brief", async () => {
    await managerCommand(["an intent"], deps());
    const rendered = brief();
    expect(rendered).not.toHaveProperty("route");
    expect(rendered).not.toHaveProperty("artifact_refs");
  });

  it("includes route in the brief once recorded", async () => {
    await managerCommand(["an intent"], deps());
    const id = String(brief().effort_id);
    out = [];

    await managerCommand(["route", id, "to-spec"], deps());
    const rendered = brief();
    expect(rendered.route).toBe("to-spec");
    expect(rendered).not.toHaveProperty("artifact_refs");
  });

  it("includes both route and artifact_refs once both are recorded", async () => {
    await managerCommand(["an intent"], deps());
    const id = String(brief().effort_id);
    out = [];

    await managerCommand(["route", id, "to-spec"], deps());
    out = [];
    await managerCommand(["artifact", id, "https://github.com/x/issues/1"], deps());

    const rendered = brief();
    expect(rendered.route).toBe("to-spec");
    expect(rendered.artifact_refs).toEqual(["https://github.com/x/issues/1"]);
  });
});
