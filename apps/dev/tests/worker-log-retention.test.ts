import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import {
  runWithQuiescentWorkerLogTrim,
  trimWorkerLogAtQuiescentPoint,
} from "../src/runtime/worker-log-retention.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function lane(ids: readonly string[]): string {
  const writer = encodeLines({ trailer: false });
  return ids
    .map((id) => writer.push({ id } satisfies ToonlRecord))
    .join("");
}

describe("worker log retention", () => {
  it("trims an oversized log at a quiescent boundary and the next invocation appends", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-log-retention-"));
    roots.push(root);
    const path = join(root, "worker.log.toonl");
    await writeFile(path, lane(["one", "two", "three", "four"]), "utf8");

    expect(
      await trimWorkerLogAtQuiescentPoint(path, {
        maxLines: 3,
        trimOptions: { runTq: async () => false },
      }),
    ).toBe(true);

    await writeFile(path, lane(["five"]), { encoding: "utf8", flag: "a" });
    expect(parseRecords(await readFile(path, "utf8")).map((row) => row.id)).toEqual([
      "two",
      "three",
      "four",
      "five",
    ]);
  });

  it("never trims while the runner still owns its live file logger", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-log-retention-live-"));
    roots.push(root);
    const path = join(root, "worker.log.toonl");
    const oversized = lane(["one", "two", "three"]);
    await writeFile(path, oversized, "utf8");

    let settle!: () => void;
    const liveRun = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const wrapped = runWithQuiescentWorkerLogTrim(
      path,
      () => liveRun,
      { maxLines: 2, trimOptions: { runTq: async () => false } },
    );

    await Promise.resolve();
    expect(await readFile(path, "utf8")).toBe(oversized);

    settle();
    await wrapped;
    expect(parseRecords(await readFile(path, "utf8")).map((row) => row.id)).toEqual([
      "two",
      "three",
    ]);
  });
});
