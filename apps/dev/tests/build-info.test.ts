import { afterEach, describe, expect, it } from "vitest";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";

const originalVersion = process.env.RED_BUILD_VERSION;
const originalGitSha = process.env.RED_BUILD_GIT_SHA;
const originalBuildTime = process.env.RED_BUILD_TIME;
const originalBundleAsset = process.env.RED_BUNDLE_ASSET;

afterEach(() => {
  restoreEnv("RED_BUILD_VERSION", originalVersion);
  restoreEnv("RED_BUILD_GIT_SHA", originalGitSha);
  restoreEnv("RED_BUILD_TIME", originalBuildTime);
  restoreEnv("RED_BUNDLE_ASSET", originalBundleAsset);
});

describe("build info", () => {
  it("reads env fallback metadata and normalizes git tag versions", () => {
    process.env.RED_BUILD_VERSION = "v1.146.1";
    process.env.RED_BUILD_GIT_SHA = "abc123";
    process.env.RED_BUILD_TIME = "2026-06-01T00:00:00.000Z";
    process.env.RED_BUNDLE_ASSET = "dev.bundle.min.mjs";

    const info = readBuildInfo("dev");

    expect(info).toEqual({
      app: "dev",
      version: "1.146.1",
      gitSha: "abc123",
      buildTime: "2026-06-01T00:00:00.000Z",
      bundleAsset: "dev.bundle.min.mjs",
    });
    expect(renderVersion(info)).toBe("dev 1.146.1 abc123");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
