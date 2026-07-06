import { describe, expect, it } from "vitest";
import {
  assetUrl,
  compareSemver,
  newestSameMajorFromRegistry,
  parseSemver,
  parseSha256File,
  platformKey,
  pointerFileName,
  readPointerVersion,
  registryPackageUrl,
  sameMajor,
  selectInRangeUpdate,
  sha256Hex,
  // @ts-expect-error — dependency-free .mjs bootstrap ships without type declarations
} from "../../../plugins/memory/scripts/bootstrap.mjs";

describe("bootstrap pure helpers (ADR 0029)", () => {
  describe("platformKey", () => {
    it("maps the published reddb release targets", () => {
      expect(platformKey("linux", "x64")).toBe("linux-x86_64");
      expect(platformKey("linux", "arm64")).toBe("linux-aarch64");
      expect(platformKey("linux", "arm")).toBe("linux-armv7");
      expect(platformKey("darwin", "x64")).toBe("macos-x86_64");
      expect(platformKey("darwin", "arm64")).toBe("macos-aarch64");
      expect(platformKey("win32", "x64")).toBe("windows-x86_64");
    });

    it("returns null for unsupported platform/arch", () => {
      expect(platformKey("sunos", "x64")).toBeNull();
      expect(platformKey("linux", "ppc64")).toBeNull();
    });
  });

  describe("assetUrl", () => {
    it("composes the GitHub release download URL", () => {
      expect(assetUrl("reddb-io/reddb", "v1.7.0", "red-linux-x86_64")).toBe(
        "https://github.com/reddb-io/reddb/releases/download/v1.7.0/red-linux-x86_64",
      );
    });
  });

  describe("parseSha256File", () => {
    it("extracts the hex digest from a `<hex>  <name>` line", () => {
      const hex = "a".repeat(64);
      expect(parseSha256File(`${hex}  red-linux-x86_64`)).toBe(hex);
      expect(parseSha256File(`  ${hex}\n`)).toBe(hex);
    });

    it("lowercases and rejects malformed bodies", () => {
      expect(parseSha256File("A".repeat(64))).toBe("a".repeat(64));
      expect(parseSha256File("not a checksum")).toBeNull();
      expect(parseSha256File("")).toBeNull();
    });
  });

  describe("sha256Hex", () => {
    it("hashes a buffer deterministically", () => {
      expect(sha256Hex(Buffer.from("reddb"))).toBe(
        sha256Hex(Buffer.from("reddb")),
      );
      expect(sha256Hex(Buffer.from(""))).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
    });
  });
});

describe("in-range self-update policy (ADR 0084, mirror of packages/shared/self-update.ts)", () => {
  it("parseSemver reads a leading x.y.z and rejects junk", () => {
    expect(parseSemver("1.140.0")).toEqual({ major: 1, minor: 140, patch: 0 });
    expect(parseSemver("nope")).toBeNull();
  });

  it("compareSemver orders numerically, not lexically", () => {
    expect(compareSemver("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("1.140.2", "1.140.2")).toBe(0);
  });

  it("sameMajor gates the compatible range", () => {
    expect(sameMajor("1.140.0", "1.999.9")).toBe(true);
    expect(sameMajor("1.140.0", "2.0.0")).toBe(false);
  });

  it("selectInRangeUpdate accepts a newer same-major, rejects out-of-range/downgrade", () => {
    expect(selectInRangeUpdate("1.140.0", "1.140.0", "1.145.0")).toBe("1.145.0");
    expect(selectInRangeUpdate("1.140.0", "1.140.0", "2.0.0")).toBeNull();
    expect(selectInRangeUpdate("1.140.0", "1.140.0", "1.140.0")).toBeNull();
    // Compares against `current`, not `installed`, so a done update is never re-picked.
    expect(selectInRangeUpdate("1.140.0", "1.145.0", "1.145.0")).toBeNull();
  });

  it("registryPackageUrl escapes the scoped name and never builds a releases/download URL", () => {
    const url = registryPackageUrl();
    expect(url).toMatch(/\/@reddb-io%2Fred-skills$/);
    expect(url).not.toContain("releases/download");
  });

  it("newestSameMajorFromRegistry picks the newest same-major version (ADR 0091)", () => {
    const meta = JSON.stringify({
      versions: { "1.140.0": {}, "1.145.2": {}, "1.144.0": {}, "2.0.0": {} },
    });
    expect(newestSameMajorFromRegistry(meta, "1.140.0")).toBe("1.145.2");
    // Never crosses a major, and tolerates malformed metadata.
    expect(newestSameMajorFromRegistry(JSON.stringify({ versions: { "2.0.0": {} } }), "1.140.0")).toBeNull();
    expect(newestSameMajorFromRegistry("not json", "1.140.0")).toBeNull();
  });

  it("pointerFileName / readPointerVersion round-trip", () => {
    expect(pointerFileName("memory")).toBe("memory-stable.current");
    expect(readPointerVersion(JSON.stringify({ version: "1.145.0" }))).toBe("1.145.0");
    expect(readPointerVersion("1.145.0")).toBe("1.145.0");
    expect(readPointerVersion("garbage")).toBe("");
  });
});
