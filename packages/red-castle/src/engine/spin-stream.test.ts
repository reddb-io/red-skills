import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCastleLaneWriters,
  createEnginePaths,
  createSpinStreamProcessor,
  readCastleLaneRecords,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Spin runner-stream processing", () => {
  it("logs and steers a continuing Spin exactly once per episode", async () => {
    const root = await mkdtemp(join(tmpdir(), "spin-stream-"));
    roots.push(root);
    const workerLog = createCastleLaneWriters(
      createEnginePaths(join(root, ".red")),
      { clock: () => "2026-08-13T00:00:00.000Z" },
    ).worker("wSPIN");
    const steers: string[] = [];
    const stream = createSpinStreamProcessor({
      workerLog,
      steer: (message) => {
        steers.push(message);
      },
    });

    for (let index = 1; index <= 7; index += 1) {
      await stream.observe({
        type: "text",
        message: `unproductive thought ${index}`,
        iteration: 1,
        timestamp: new Date(0),
      });
    }

    expect(await readCastleLaneRecords(workerLog.path)).toEqual([
      {
        at: "2026-08-13T00:00:00.000Z",
        kind: "worker.spin",
        payload: { pattern: "monologue" },
      },
    ]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("monologue");
  });

  it("normalizes runner tool calls and results for Spin evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "spin-stream-"));
    roots.push(root);
    const workerLog = createCastleLaneWriters(
      createEnginePaths(join(root, ".red")),
      { clock: () => "2026-08-13T00:00:00.000Z" },
    ).worker("wPAIR");
    const steers: string[] = [];
    const stream = createSpinStreamProcessor({
      workerLog,
      steer: (message) => {
        steers.push(message);
      },
    });

    for (let index = 0; index < 3; index += 1) {
      await stream.observe({
        type: "toolCall",
        name: "Bash",
        formattedArgs: "pnpm test",
        iteration: 1,
        timestamp: new Date(0),
      });
      await stream.observe({
        type: "result",
        result: "1 test failed",
        iteration: 1,
        timestamp: new Date(0),
      });
    }

    expect((await readCastleLaneRecords(workerLog.path))[0]).toMatchObject({
      kind: "worker.spin",
      payload: { pattern: "repeated-action-observation" },
    });
    expect(steers).toEqual([
      expect.stringContaining("repeated-action-observation"),
    ]);
  });
});
