import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubAttributionLedger } from "./attribution.js";
import { createGithubBalanceHistory } from "./balance-history.js";
import type { GithubBalance } from "./balance.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "identity-history-"));
  roots.push(root);
  return root;
}

function balance(remaining: number): GithubBalance {
  const reset = "2026-08-13T12:00:00.000Z";
  const pool = (name: "rest" | "graphql") => ({
    pool: name,
    resource: name === "rest" ? "core" : "graphql",
    remaining,
    used: 5_000 - remaining,
    limit: 5_000,
    reset_at: reset,
    fraction: remaining / 5_000,
  });
  return {
    version: 1,
    origin: "asked",
    outcome: "asked",
    source: "rate_limit",
    asked_at: "2026-08-13T11:00:00.000Z",
    pools: { rest: pool("rest"), graphql: pool("graphql"), search: null },
  } as unknown as GithubBalance;
}

describe("a series says whose ceiling it measures", () => {
  it("stamps the identity on every balance row, so two buckets are two series", async () => {
    const root = tempRoot();
    const path = join(root, "balance-history.toonl");

    await createGithubBalanceHistory({ path, clock: () => "2026-08-13T11:00:00.000Z" })
      .append(balance(4_400));
    await createGithubBalanceHistory({
      path,
      identity: "app:153309957",
      clock: () => "2026-08-13T11:00:01.000Z",
    }).append(balance(5_000));

    const written = readFileSync(path, "utf8");
    // A consumer plotting the machine — the wallpaper is one — must be able to
    // separate the two sawtooths; interleaved and unlabelled they read as one
    // impossible series.
    expect(written).toContain("pat");
    expect(written).toContain("app:153309957");
  });

  it("stamps the payer on spend, so a total never charges a bucket that never paid", async () => {
    const root = tempRoot();
    const path = join(root, "spend.toonl");

    await createGithubAttributionLedger({ path, identity: "app:153309957" })
      .record({ operation: { key: "issue list", budget: "rest" }, cost: 1 });

    expect(readFileSync(path, "utf8")).toContain("app:153309957");
  });

  it("defaults to the person, so a host with no App reads exactly as before", async () => {
    const root = tempRoot();
    const path = join(root, "spend.toonl");

    await createGithubAttributionLedger({ path })
      .record({ operation: { key: "issue list", budget: "rest" }, cost: 1 });

    expect(readFileSync(path, "utf8")).not.toContain("app:");
  });
});
