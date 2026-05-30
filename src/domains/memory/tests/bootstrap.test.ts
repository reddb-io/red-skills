import { describe, expect, it } from "vitest";
// @ts-expect-error — dependency-free .mjs bootstrap ships without type declarations
import { assetUrl, parseSha256File, platformKey, sha256Hex } from "../../../../plugins/memory/scripts/bootstrap.mjs";

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
