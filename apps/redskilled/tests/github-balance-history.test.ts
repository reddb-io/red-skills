import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGithubBalanceHistory,
  parseGithubBalance,
} from "@reddb-io/github";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";

import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const daemons: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop().catch(() => undefined)));
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

describe("redskilled GitHub balance history", () => {
  it("piggybacks every pool row on asks without making another GitHub request", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-balance-history-"));
    roots.push(root);
    const historyPath = join(root, "state", "github", "balance-history.toonl");
    let hydrated!: () => void;
    const hydration = new Promise<void>((resolve) => { hydrated = resolve; });
    const initial = parseGithubBalance(answer(1_000), { askedAt: "2026-08-11T20:59:00.000Z" });
    const remaining = [1_000, 700, 0];
    let asks = 0;
    const daemon = await startRedskilledDaemon({
      paths: resolveRedskilledPaths({
        env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
        runtimeDir: root,
      }),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: {
        transport: async () => {
          const value = remaining[asks]!;
          asks += 1;
          return answer(value);
        },
        store: {
          read: async () => { hydrated(); return initial; },
          write: async () => undefined,
        },
        history: createGithubBalanceHistory({
          path: historyPath,
          clock: () => "2026-08-11T21:59:59.000Z",
        }),
        intervalMsOverride: 3_600_000,
      },
    });
    daemons.push(daemon);
    await hydration;
    await new Promise((resolve) => setTimeout(resolve, 0));

    await daemon.pollGithubBalance();
    await daemon.pollGithubBalance();
    await daemon.pollGithubBalance();

    const rows = parseRecords(await readFile(historyPath, "utf8"));
    expect(asks).toBe(3);
    expect(rows).toHaveLength(9);
    expect(rows.filter((row) => row.pool === "graphql").map((row) => row.remaining)).toEqual([
      1_000,
      700,
      0,
    ]);
  });

  it("records the person and the optional App as two independent series", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-identity-balance-history-"));
    roots.push(root);
    const historyPath = join(root, "state", "github", "balance-history.toonl");
    const daemon = await startRedskilledDaemon({
      paths: resolveRedskilledPaths({
        env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
        runtimeDir: root,
      }),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      githubBalance: {
        transport: async () => answer(4_400),
        history: createGithubBalanceHistory({ path: historyPath, identity: "pat" }),
        observers: [{
          identity: "app:153309957",
          transport: async () => answer(4_900),
          history: createGithubBalanceHistory({ path: historyPath, identity: "app:153309957" }),
        }],
        intervalMsOverride: 3_600_000,
      },
    });
    daemons.push(daemon);

    await daemon.pollGithubBalance();

    const rows = parseRecords(await readFile(historyPath, "utf8"));
    expect(new Set(rows.map((row) => row.identity))).toEqual(new Set(["pat", "app:153309957"]));
  });
});
