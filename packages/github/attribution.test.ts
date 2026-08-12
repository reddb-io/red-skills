import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubAttributionLedger } from "./attribution.js";
import { routeGithubArgs } from "./surface.js";

const HOUR_START = "2026-08-03T12:00:00.000Z";
const HOUR_END = "2026-08-03T13:00:00.000Z";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function ledgerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "github-attribution-"));
  temporaryDirectories.push(directory);
  return join(directory, "spend.jsonl");
}

describe("the GitHub spend attribution ledger", () => {
  it("answers what spent the GraphQL pool in a window after a process restart", async () => {
    const path = await ledgerPath();
    const firstProcess = createGithubAttributionLedger({ path });

    await firstProcess.record({
      operation: routeGithubArgs(["label", "list"]),
      cost: 7,
      observedAt: "2026-08-03T12:10:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["label", "list"]),
      cost: 5,
      observedAt: "2026-08-03T12:20:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["api", "graphql"]),
      cost: 3,
      observedAt: "2026-08-03T12:30:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["issue", "view", "42"]),
      cost: 1,
      observedAt: "2026-08-03T12:40:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["label", "list"]),
      cost: 99,
      observedAt: "2026-08-03T11:59:59.999Z",
    });

    const persisted = await readFile(path, "utf8");
    expect(persisted).toMatch(/^\[\]/);
    expect(persisted).not.toContain('{"version":1');

    // A new ledger instance models a restarted process: the answer must come
    // from durable observations, not from counters held by the first instance.
    const restartedProcess = createGithubAttributionLedger({ path });
    const report = await restartedProcess.report({
      from: HOUR_START,
      to: HOUR_END,
      pool: "graphql",
    });

    expect(report.origin).toBe("process-attribution");
    expect(report.window).toEqual({ from: HOUR_START, to: HOUR_END });
    expect(report.pool).toBe("graphql");
    expect(report.total_count).toBe(3);
    expect(report.total_cost).toBe(15);
    expect(report.operations).toEqual([
      { operation_key: "label list", pool: "graphql", count: 2, cost: 12 },
      { operation_key: "api graphql", pool: "graphql", count: 1, cost: 3 },
    ]);
  });

  it("keeps pool attribution separate when one window reports every pool", async () => {
    const path = await ledgerPath();
    const ledger = createGithubAttributionLedger({ path });

    await ledger.record({
      operation: routeGithubArgs(["label", "list"]),
      cost: 4,
      observedAt: "2026-08-03T12:05:00.000Z",
    });
    await ledger.record({
      operation: routeGithubArgs(["issue", "view", "42"]),
      cost: 1,
      observedAt: "2026-08-03T12:06:00.000Z",
    });

    const report = await ledger.report({ from: HOUR_START, to: HOUR_END });

    expect(report.pool).toBeNull();
    expect(report.operations).toEqual([
      { operation_key: "label list", pool: "graphql", count: 1, cost: 4 },
      { operation_key: "issue view", pool: "rest", count: 1, cost: 1 },
    ]);
  });

  it("keeps the actor that spent a routed operation instead of merging Workers", async () => {
    const path = await ledgerPath();
    const ledger = createGithubAttributionLedger({ path });

    await ledger.record({
      operation: routeGithubArgs(["issue", "list"]),
      cost: 8,
      actor: "worker:wONE",
      observedAt: "2026-08-03T12:05:00.000Z",
    });
    await ledger.record({
      operation: routeGithubArgs(["issue", "list"]),
      cost: 3,
      actor: "worker:wTWO",
      observedAt: "2026-08-03T12:06:00.000Z",
    });

    const report = await ledger.report({ from: HOUR_START, to: HOUR_END });

    expect(report.operations).toEqual([
      { operation_key: "issue list", pool: "rest", actor: "worker:wONE", count: 1, cost: 8 },
      { operation_key: "issue list", pool: "rest", actor: "worker:wTWO", count: 1, cost: 3 },
    ]);
  });

  it("trims an over-ceiling lane to half while concurrent writes and reports stay serialized", async () => {
    const path = await ledgerPath();
    const maxBytes = 700;
    const ledger = createGithubAttributionLedger({ path, maxBytes });

    let previousBytes = 0;
    let trimmed = false;
    for (let index = 0; index < 20; index += 1) {
      await ledger.record({
        operation: routeGithubArgs(["issue", "view", String(index)]),
        cost: index + 1,
        actor: `worker:w${String(index).padStart(2, "0")}`,
        observedAt: `2026-08-03T12:${String(index).padStart(2, "0")}:00.000Z`,
      });
      const currentBytes = (await stat(path)).size;
      if (currentBytes < previousBytes) {
        expect(currentBytes).toBeLessThanOrEqual(Math.floor(maxBytes / 2));
        trimmed = true;
        break;
      }
      previousBytes = currentBytes;
    }
    expect(trimmed).toBe(true);

    await Promise.all(
      Array.from({ length: 20 }, (_, offset) => {
        const index = offset + 20;
        return ledger.record({
          operation: routeGithubArgs(["issue", "view", String(index)]),
          cost: index + 1,
          actor: `worker:w${String(index).padStart(2, "0")}`,
          observedAt: `2026-08-03T12:${String(index).padStart(2, "0")}:00.000Z`,
        });
      }),
    );

    const raw = await readFile(path, "utf8");
    const rows = parseRecords(raw);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(40);
    expect((await stat(path)).size).toBeLessThanOrEqual(maxBytes);
    expect(rows.at(-1)).toMatchObject({ actor: "worker:w39", cost: 40 });

    const report = await ledger.report({ from: HOUR_START, to: HOUR_END });
    expect(report.unreadable_records).toBe(0);
    expect(report.total_count).toBe(rows.length);
    expect(report.total_cost).toBe(rows.reduce((sum, row) => sum + Number(row.cost), 0));
  });
});

describe("a failed ledger write (#3768)", () => {
  it("fails its own caller and no one else", async () => {
    // A record larger than the whole lane can never be appended: the ledger
    // throws rather than trimming everything away. Before this, that one throw
    // poisoned the shared write chain, so every LATER record rejected without
    // running — and because a GitHub read awaits the ledger, the client stopped
    // reading for the life of the process.
    const path = await ledgerPath();
    const ledger = createGithubAttributionLedger({ path, maxBytes: 4_096 });
    const operation = routeGithubArgs(["issue", "view", "7"]);

    const refused = await ledger
      .record({ operation, cost: 1, actor: "x".repeat(8_192), observedAt: HOUR_START })
      .then(() => null, (thrown: unknown) => thrown);
    expect(String(refused)).toContain("lane ceiling");

    await expect(
      ledger.record({ operation, cost: 1, actor: "worker:w1", observedAt: HOUR_START }),
    ).resolves.toBeUndefined();
    await expect(
      ledger.record({ operation, cost: 1, actor: "worker:w2", observedAt: HOUR_START }),
    ).resolves.toBeUndefined();

    const report = await ledger.report({ from: HOUR_START, to: HOUR_END });
    expect(report.total_count).toBe(2);
  });
});
