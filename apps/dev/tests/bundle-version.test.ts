import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusFileName } from "@reddb-io/shared/self-update.js";
import { describe, expect, it } from "vitest";
import { readDevBundleCacheState } from "../src/core/bundle-version.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";

describe("dev bundle cache state", () => {
  it("reads the self-update state through the TOON sniff decoder", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-bundle-cache-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, statusFileName("dev")),
        encodeDevSnapshotToon({
          lastFailureAtMs: 100,
          lastError: "fetch failed",
        }),
        "utf8",
      );

      expect(readDevBundleCacheState("2.71.0", { RED_SKILLS_CACHE_DIR: root }, 160)).toMatchObject({
        installedVersion: "2.71.0",
        lastFailureAtMs: 100,
        lastFailureAgeMs: 60,
        lastError: "fetch failed",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
