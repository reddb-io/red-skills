import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubBalanceStore } from "./balance-store.js";
import { parseGithubBalance } from "./balance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the cross-process GitHub balance state", () => {
  it("shares independent pool balances with a fresh process through bounded TOON state", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-balance-store-"));
    roots.push(root);
    const path = join(root, "state", "github", "balance.toon");
    const graphqlReset = "2026-08-11T22:00:00.000Z";
    const observed = parseGithubBalance({
      resources: {
        core: { limit: 5_000, remaining: 4_883, used: 117, reset: Date.parse(graphqlReset) / 1_000 },
        graphql: { limit: 5_000, remaining: 0, used: 5_000, reset: Date.parse(graphqlReset) / 1_000 },
        search: { limit: 30, remaining: 30, used: 0, reset: Date.parse(graphqlReset) / 1_000 },
      },
    }, { askedAt: "2026-08-11T21:15:00.000Z" });

    await createGithubBalanceStore({ path }).write(observed);
    const fromFreshProcess = await createGithubBalanceStore({ path }).read();

    expect(fromFreshProcess?.pools).toMatchObject({
      rest: { remaining: 4_883 },
      graphql: { remaining: 0, reset_at: graphqlReset },
      search: { remaining: 30 },
    });
    expect(await readFile(path, "utf8")).toContain("pools:");
  });

  it("refuses a snapshot larger than the registry-declared lane ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-balance-store-"));
    roots.push(root);
    const path = join(root, "balance.toon");
    const store = createGithubBalanceStore({ path, maxBytes: 32 });
    const observed = parseGithubBalance({
      resources: { core: { limit: 5_000, remaining: 4_883, used: 117, reset: 0 } },
    }, { askedAt: "2026-08-11T21:15:00.000Z" });

    await expect(store.write(observed)).rejects.toThrow("lane ceiling");
  });
});
