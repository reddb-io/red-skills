import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { createEnginePaths } from "./paths.js";
import {
  createSingletonEventLane,
  singletonEventLanePath,
} from "./singleton-event-lane.js";

describe("castle singleton event lane", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("appends TOONL events and reads a bounded tail through injected IO", async () => {
    const root = join(
      tmpdir(),
      `castle-singleton-events-${crypto.randomUUID()}`,
    );
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    let tick = 0;
    const times = [
      "2026-07-22T19:00:00.000Z",
      "2026-07-22T19:00:01.000Z",
      "2026-07-22T19:00:02.000Z",
    ];
    const lane = createSingletonEventLane(paths, {
      fs: { appendFile, mkdir, readFile },
      clock: () => times[tick++]!,
    });

    await lane.append({
      singleton: "github-webhook",
      kind: "github.delivery",
      payload: { delivery: "d1" },
    });
    await lane.append({
      singleton: "github-webhook",
      kind: "github.delivery",
      payload: { delivery: "d2" },
    });
    await lane.append({
      singleton: "janitor",
      kind: "janitor.completed",
      payload: { swept: 3 },
    });

    expect(singletonEventLanePath(paths)).toBe(
      join(paths.castleStateRoot, "singleton-events.toonl"),
    );
    expect(await lane.read({ tail: 2 })).toEqual([
      {
        at: "2026-07-22T19:00:01.000Z",
        singleton: "github-webhook",
        kind: "github.delivery",
        payload: { delivery: "d2" },
      },
      {
        at: "2026-07-22T19:00:02.000Z",
        singleton: "janitor",
        kind: "janitor.completed",
        payload: { swept: 3 },
      },
    ]);

    const bytes = await readFile(singletonEventLanePath(paths), "utf8");
    expect(bytes.trimStart().startsWith("{")).toBe(false);
    expect(parseRecords(bytes)).toHaveLength(3);
  });

  it("rewrites an overflowing lane to half its byte ceiling and preserves tail reads", async () => {
    const root = join(
      tmpdir(),
      `castle-singleton-events-${crypto.randomUUID()}`,
    );
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const lane = createSingletonEventLane(paths, {
      maxBytes: 600,
    });

    for (let delivery = 1; delivery <= 5; delivery += 1) {
      await lane.append({
        at: `2026-07-22T19:00:0${delivery}.000Z`,
        singleton: "github-webhook",
        kind: "github.delivery",
        payload: { delivery: `d${delivery}`, detail: "xxxxxxxx" },
      });
    }

    const bytes = await readFile(singletonEventLanePath(paths), "utf8");
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(300);
    expect(await lane.read({ tail: 2 })).toEqual([
      {
        at: "2026-07-22T19:00:04.000Z",
        singleton: "github-webhook",
        kind: "github.delivery",
        payload: { delivery: "d4", detail: "xxxxxxxx" },
      },
      {
        at: "2026-07-22T19:00:05.000Z",
        singleton: "github-webhook",
        kind: "github.delivery",
        payload: { delivery: "d5", detail: "xxxxxxxx" },
      },
    ]);
  });
});
