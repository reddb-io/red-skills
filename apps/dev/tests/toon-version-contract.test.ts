import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectToonPinDrift, readCatalogToonVersion, TOON_PIN_SITES } from "../src/core/toon-version.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("toon catalog version contract", () => {
  it("derives the toon/tq version from the pnpm catalog", () => {
    expect(readCatalogToonVersion(ROOT)).toEqual({
      packageName: "@reddb-io/toon",
      version: "0.3.0",
      tag: "v0.3.0",
    });
  });

  it("keeps every registered derived toon/tq pin aligned with the catalog", async () => {
    await expect(collectToonPinDrift(ROOT, readCatalogToonVersion(ROOT))).resolves.toEqual([]);
  });

  it("names every stale registered site after a catalog-only bump", async () => {
    const failures = await collectToonPinDrift(ROOT, {
      packageName: "@reddb-io/toon",
      version: "9.9.9",
      tag: "v9.9.9",
    });

    expect(failures).toEqual(TOON_PIN_SITES.map((site) => expect.stringContaining(`${site.name}:`)));
  });
});
