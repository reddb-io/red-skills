import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectToonPinDrift,
  collectToonSpecifierDrift,
  readCatalogToonVersion,
  TOON_PIN_SITES,
} from "../src/core/toon-version.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("toon catalog version contract", () => {
  it("derives the toon/tq version from the pnpm catalog", () => {
    expect(readCatalogToonVersion(ROOT)).toEqual({
      packageName: "@reddb-io/toon",
      version: "0.21.0",
      tag: "v0.21.0",
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

  it("lets no workspace package own an independent toon version", async () => {
    await expect(collectToonSpecifierDrift(ROOT)).resolves.toEqual([]);
  });

  it("names a workspace package that pins toon itself instead of deferring to the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-toon-specifier-"));
    try {
      await writeFile(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n', "utf8");
      await mkdir(join(root, "packages", "obedient"), { recursive: true });
      await mkdir(join(root, "packages", "rogue"), { recursive: true });
      await writeFile(
        join(root, "packages", "obedient", "package.json"),
        JSON.stringify({ name: "obedient", dependencies: { "@reddb-io/toon": "catalog:" } }),
        "utf8",
      );
      await writeFile(
        join(root, "packages", "rogue", "package.json"),
        JSON.stringify({ name: "rogue", dependencies: { "@reddb-io/toon": "^0.3.0" } }),
        "utf8",
      );

      await expect(collectToonSpecifierDrift(root)).resolves.toEqual([
        "packages/rogue/package.json (dependencies): expected catalog:, found ^0.3.0",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
