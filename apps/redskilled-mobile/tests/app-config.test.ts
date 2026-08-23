import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { androidVersionCode } = require("../app.config.js") as {
  androidVersionCode(version: string): number;
};

describe("Android app config", () => {
  it("derives a monotonic versionCode from the product semver", () => {
    expect(androidVersionCode("4.1.34")).toBe(4_001_034);
    expect(androidVersionCode("4.2.0")).toBeGreaterThan(
      androidVersionCode("4.1.999"),
    );
  });

  it("refuses unsupported version components", () => {
    expect(() => androidVersionCode("4.1.1000")).toThrow(/exceeds 999/);
    expect(() => androidVersionCode("next")).toThrow(/Cannot derive/);
  });
});
