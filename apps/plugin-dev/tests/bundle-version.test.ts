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

  it("suppresses the failure age when a later success supersedes the failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-bundle-cache-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, statusFileName("dev")),
        encodeDevSnapshotToon({
          lastCheckAtMs: 200,
          lastFailureAtMs: 100,
          lastSuccessAtMs: 200,
          lastStatus: "up-to-date",
        }),
        "utf8",
      );

      const state = readDevBundleCacheState("2.71.0", { RED_SKILLS_CACHE_DIR: root }, 100_000_000);
      expect(state.lastFailureAgeMs).toBeUndefined();
      expect(state).toMatchObject({
        lastStatus: "up-to-date",
        lastCheckAtMs: 200,
        lastCheckAgeMs: 100_000_000 - 200,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the failure age when the failure is newer than the last success", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-bundle-cache-"));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(
        join(root, statusFileName("dev")),
        encodeDevSnapshotToon({
          lastFailureAtMs: 300,
          lastSuccessAtMs: 200,
          lastStatus: "error",
          lastError: "fetch failed",
        }),
        "utf8",
      );

      expect(readDevBundleCacheState("2.71.0", { RED_SKILLS_CACHE_DIR: root }, 100_000_000)).toMatchObject({
        lastFailureAtMs: 300,
        lastFailureAgeMs: 100_000_000 - 300,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
