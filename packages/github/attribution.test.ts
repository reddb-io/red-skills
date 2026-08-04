import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      operation: routeGithubArgs(["pr", "list"]),
      cost: 7,
      observedAt: "2026-08-03T12:10:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["pr", "list"]),
      cost: 5,
      observedAt: "2026-08-03T12:20:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["issue", "list"]),
      cost: 3,
      observedAt: "2026-08-03T12:30:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["issue", "view", "42"]),
      cost: 1,
      observedAt: "2026-08-03T12:40:00.000Z",
    });
    await firstProcess.record({
      operation: routeGithubArgs(["pr", "list"]),
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
      { operation_key: "pr list", pool: "graphql", count: 2, cost: 12 },
      { operation_key: "issue list", pool: "graphql", count: 1, cost: 3 },
    ]);
  });

  it("keeps pool attribution separate when one window reports every pool", async () => {
    const path = await ledgerPath();
    const ledger = createGithubAttributionLedger({ path });

    await ledger.record({
      operation: routeGithubArgs(["issue", "list"]),
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
      { operation_key: "issue list", pool: "graphql", count: 1, cost: 4 },
      { operation_key: "issue view", pool: "rest", count: 1, cost: 1 },
    ]);
  });
});
