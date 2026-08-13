import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubBalanceHistory } from "./balance-history.js";
import { parseGithubBalance } from "./balance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function answer(graphqlRemaining: number): unknown {
  const reset = Date.parse("2026-08-11T22:00:00.000Z") / 1_000;
  return {
    resources: {
      core: { limit: 5_000, remaining: 4_883, used: 117, reset },
      graphql: { limit: 5_000, remaining: graphqlRemaining, used: 5_000 - graphqlRemaining, reset },
      search: { limit: 30, remaining: 30, used: 0, reset },
    },
  };
}

describe("the GitHub pool curve", () => {
  it("keeps readable pool rows for regular asks, reserved-band entry, and zero crossing", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-balance-history-"));
    roots.push(root);
    const path = join(root, "balance-history.toonl");
    const instants = [
      "2026-08-11T21:00:01.000Z",
      "2026-08-11T21:10:01.000Z",
      "2026-08-11T21:10:16.000Z",
    ];
    const history = createGithubBalanceHistory({ path, clock: () => instants.shift()! });

    await history.append(parseGithubBalance(answer(1_000), { askedAt: "2026-08-11T21:00:00.000Z" }));
    await history.append(parseGithubBalance(answer(700), { askedAt: "2026-08-11T21:10:00.000Z" }));
    await history.append(parseGithubBalance(answer(0), { askedAt: "2026-08-11T21:10:15.000Z" }));

    const rows = parseRecords(await readFile(path, "utf8"));
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.pool === "graphql")).toEqual([
      {
        ts: "2026-08-11T21:00:01.000Z",
        identity: "pat",
        pool: "graphql",
        remaining: 1_000,
        used: 4_000,
        limit: 5_000,
        reset_at: 1_786_485_600,
        asked_at: "2026-08-11T21:00:00.000Z",
      },
      {
        ts: "2026-08-11T21:10:01.000Z",
        identity: "pat",
        pool: "graphql",
        remaining: 700,
        used: 4_300,
        limit: 5_000,
        reset_at: 1_786_485_600,
        asked_at: "2026-08-11T21:10:00.000Z",
      },
      {
        ts: "2026-08-11T21:10:16.000Z",
        identity: "pat",
        pool: "graphql",
        remaining: 0,
        used: 5_000,
        limit: 5_000,
        reset_at: 1_786_485_600,
        asked_at: "2026-08-11T21:10:15.000Z",
      },
    ]);
  });

  it("keeps the newest complete rows under the history lane ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-balance-history-"));
    roots.push(root);
    const path = join(root, "balance-history.toonl");
    const history = createGithubBalanceHistory({
      path,
      maxBytes: 800,
      clock: () => "2026-08-11T21:59:59.000Z",
    });

    for (let remaining = 19; remaining >= 0; remaining -= 1) {
      await history.append(parseGithubBalance(answer(remaining), {
        askedAt: `2026-08-11T21:${String(40 - remaining).padStart(2, "0")}:00.000Z`,
      }));
    }

    const rows = parseRecords(await readFile(path, "utf8"));
    expect((await stat(path)).size).toBeLessThanOrEqual(800);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-2)).toMatchObject({ pool: "graphql", remaining: 0, used: 5_000 });
  });
});
