import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENGINE_VALIDATION_MOMENTS,
  VALIDATION_SETTING_KEYS,
  isValidationSettingKey,
} from "../src/core/validation-moments.js";
import { loadConfig, readValidationMoments } from "../src/core/config.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/**
 * `afk.validation` holds two kinds of key and the drift audit conflated them.
 *
 * Scraping the block for names made every setting look like a moment the engine
 * had never heard of, and the remediation it printed — "remove or rename the
 * declaration" — told an operator to delete four pieces of live configuration
 * (#3466). The separation is only worth anything if each declared setting is
 * pinned to something that actually reads it, so that is what this proves.
 */
describe("validation setting keys (#3466)", () => {
  it("names a reader for every declared setting, and that reader resolves the key", () => {
    for (const [key, readerPath] of Object.entries(VALIDATION_SETTING_KEYS)) {
      const source = readFileSync(join(REPO_ROOT, readerPath), "utf8");
      expect(
        source.includes(key),
        `${readerPath} is declared as the reader of afk.validation.${key} but never mentions it. ` +
          `Either the reader moved — point the entry at its new home — or the setting is gone, ` +
          `and the entry should go with it.`,
      ).toBe(true);
    }
  });

  it("keeps settings and moments disjoint, so neither can be classified as the other", () => {
    for (const moment of ENGINE_VALIDATION_MOMENTS) {
      expect(
        isValidationSettingKey(moment),
        `${moment} is an engine moment and must not also be declared a setting`,
      ).toBe(false);
    }
  });

  it("classifies this repo's own declared keys the way the config means them", () => {
    // A regeneration declaration and four resource
    // knobs, none of which schedules anything.
    for (const setting of ["generated", "node_max_old_space_mb", "heavy_available_memory_mb", "vitest_max_workers", "turbo_concurrency"]) {
      expect(isValidationSettingKey(setting), `${setting} is a setting, not a moment`).toBe(true);
    }
    expect(isValidationSettingKey("post_done")).toBe(false);
  });

  it("reproves workspace types and repo invariants before a Worker reports DONE (#3509)", () => {
    const configPath = join(REPO_ROOT, ".red", "config.yaml");
    const values = loadConfig(configPath);

    expect(readValidationMoments(values).post_done).toEqual([
      "pnpm typecheck",
      "pnpm -C apps/dev test:invariants",
    ]);
  });
});
