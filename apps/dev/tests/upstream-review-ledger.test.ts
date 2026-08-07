import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const UPSTREAM_SHA = "8b36d4fb2635b3c21998dcd8144439c9e5ba7302";

// This test was written to read a `CHANGES.md` ledger that no longer exists: the
// parallel record of upstream divergence was retired for describing what git
// already describes, and the commit and PR body carry the reason now. A test
// cannot meaningfully assert prose in a squashed commit message, and asserting a
// file the repo decided to delete would re-litigate that decision from a fixture.
//
// What survives is the fact the pin exists to carry: which upstream commit this
// repo is based on. That is checkable, durable, and the thing a stale pin breaks.
describe("upstream pin", () => {
  it("records the reviewed v1.2.2 span", async () => {
    const upstream = await readFile(join(ROOT, ".upstream"), "utf8");
    expect(upstream).toBe(`repo=mattpocock/skills\nsha=${UPSTREAM_SHA}\n`);
  });
});
