import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managerEffortFile, managerEffortsDir } from "@reddb-io/shared/red-paths.js";
import { encodeRecords, parseRecords } from "@reddb-io/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANAGER_EFFORT_SCHEMA,
  MANAGER_EFFORT_SCHEMA_VERSION,
  ManagerGenerationError,
  ManagerSecretError,
  decodeEffortDocument,
  deriveEffortName,
  encodeEffortDocument,
  listEffortIds,
  mintEffortId,
  readEffort,
  saveEffort,
  startEffort,
  type EffortRecord,
} from "../src/core/manager/effort-store.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-store-"));
});

afterEach(() => {
  root = "";
});

describe("effort identity", () => {
  it("mints an opaque id that carries nothing from the intent", () => {
    const id = mintEffortId();
    expect(id).toMatch(/^eff_[0-9a-z]{26}$/);
    expect(mintEffortId()).not.toBe(id);
  });

  it("derives a bounded human name from the intent", () => {
    expect(deriveEffortName("migrate the billing service to the new ledger")).toBe(
      "migrate the billing service to the",
    );
    expect(deriveEffortName("   ")).toBe("untitled effort");
    expect(deriveEffortName("a".repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

describe("effort document", () => {
  const effort: EffortRecord = {
    effort_id: "eff_abcdefghijklmnopqrstuvwxyz",
    name: "walking skeleton",
    intent: "prove the manager persists an effort",
    lifecycle: "inbox",
    generation: 1,
    created_at: "2026-07-21T00:00:00.000Z",
    updated_at: "2026-07-21T00:00:00.000Z",
  };

  it("writes a versioned schema header ahead of the effort row", () => {
    const records = parseRecords(encodeEffortDocument(effort));
    expect(records[0]).toMatchObject({
      kind: "manager.effort.schema",
      schema: MANAGER_EFFORT_SCHEMA,
      version: MANAGER_EFFORT_SCHEMA_VERSION,
    });
    expect(records[1]).toMatchObject({ kind: "manager.effort", effort_id: effort.effort_id });
  });

  it("round-trips through the store encoding", () => {
    expect(decodeEffortDocument(encodeEffortDocument(effort))).toEqual(effort);
  });

  it("refuses a document whose schema version is not the one this bundle owns", () => {
    // Spread must go through `as ToonlRecord` because EffortRecord carries
    // optional array fields (artifact_refs) that ToonlRecord (flat) won't accept.
    const { artifact_refs: _a, route: _r, ...flatEffort } = effort;
    const foreign = encodeRecords([
      { kind: "manager.effort.schema", schema: MANAGER_EFFORT_SCHEMA, version: 99 },
      { kind: "manager.effort", ...flatEffort },
    ], {});
    expect(() => decodeEffortDocument(foreign)).toThrow(/schema version/);
  });

  it("refuses to encode secret-shaped content instead of persisting it", () => {
    const leaky = { ...effort, intent: "use token ghp_0123456789abcdefghijklmnopqrstuvwxyz" };
    expect(() => encodeEffortDocument(leaky)).toThrow(ManagerSecretError);
  });
});

describe("starting and reading an effort", () => {
  it("persists a new effort at generation 1 under the effort lane", async () => {
    const effort = await startEffort({ root, intent: "prove the walking skeleton" });
    expect(effort.lifecycle).toBe("inbox");
    expect(effort.generation).toBe(1);
    expect(effort.name).toBe("prove the walking skeleton");

    const path = managerEffortFile(root, effort.effort_id);
    expect(decodeEffortDocument(await readFile(path, "utf8"))).toEqual(effort);
    expect(await readEffort(root, effort.effort_id)).toEqual(effort);
  });

  it("leaves no temp file behind, so a reader only ever sees whole documents", async () => {
    const effort = await startEffort({ root, intent: "atomic write" });
    const entries = await readdir(managerEffortsDir(root));
    expect(entries).toEqual([`${effort.effort_id}.toonl`]);
  });

  it("reads null for an unknown effort rather than throwing", async () => {
    expect(await readEffort(root, "eff_missing")).toBeNull();
  });

  it("lists the ids of every stored effort and ignores foreign files", async () => {
    const one = await startEffort({ root, intent: "first effort" });
    const two = await startEffort({ root, intent: "second effort" });
    await writeFile(join(managerEffortsDir(root), "notes.md"), "not an effort", "utf8");
    expect((await listEffortIds(root)).sort()).toEqual([one.effort_id, two.effort_id].sort());
  });
});

describe("generation counter", () => {
  it("bumps the generation on every save", async () => {
    const effort = await startEffort({ root, intent: "bump me" });
    const renamed = await saveEffort(root, { ...effort, name: "renamed" });
    expect(renamed.generation).toBe(2);
    expect((await readEffort(root, effort.effort_id))?.name).toBe("renamed");
  });

  it("fails closed when the stored generation moved past the writer's", async () => {
    const effort = await startEffort({ root, intent: "fence me" });
    await saveEffort(root, effort);
    await expect(saveEffort(root, effort)).rejects.toBeInstanceOf(ManagerGenerationError);
    expect((await readEffort(root, effort.effort_id))?.generation).toBe(2);
  });
});
