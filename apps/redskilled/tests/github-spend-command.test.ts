// The attribution ledger is only useful when a shipped surface reads it. This
// proves the operator's incident question end to end: a new process opens the
// durable lane and reports which Worker operations spent GraphQL in the last
// hour, without presenting those observations as GitHub's authoritative balance.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGithubAttributionLedger, routeGithubArgs } from "@reddb-io/github";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";

import { runGithubSpend } from "../src/cli.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("redskilled github-spend", () => {
  it("reports the last hour's GraphQL spend from a restarted durable ledger", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-github-spend-"));
    roots.push(root);
    const path = join(root, "spend.toonl");
    const writer = createGithubAttributionLedger({ path });
    await writer.record({
      operation: routeGithubArgs(["issue", "list"]),
      actor: "worker:wONE",
      cost: 7,
      observedAt: "2026-08-04T18:30:00.000Z",
    });
    await writer.record({
      operation: routeGithubArgs(["issue", "view", "3205"]),
      actor: "worker:wONE",
      cost: 1,
      observedAt: "2026-08-04T18:40:00.000Z",
    });
    await writer.record({
      operation: routeGithubArgs(["pr", "list"]),
      actor: "worker:wOLD",
      cost: 99,
      observedAt: "2026-08-04T17:59:59.999Z",
    });

    let printed = "";
    const restarted = createGithubAttributionLedger({ path });
    const code = await runGithubSpend([], {
      ledger: restarted,
      now: () => "2026-08-04T19:00:00.000Z",
      write: (text) => { printed += text; },
    });

    expect(code).toBe(0);
    expect(decode(printed)).toEqual({
      version: 1,
      origin: "process-attribution",
      window: {
        from: "2026-08-04T18:00:00.000Z",
        to: "2026-08-04T19:00:00.000Z",
      },
      pool: "graphql",
      total_count: 1,
      total_cost: 7,
      operations: [
        {
          operation_key: "issue list",
          pool: "graphql",
          actor: "worker:wONE",
          count: 1,
          cost: 7,
        },
      ],
      unreadable_records: 0,
    });
  });
});
