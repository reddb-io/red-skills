import { describe, expect, it } from "vitest";

import {
  BrandTokenError,
  resolveColorToken,
  tokenToAnsiBackground,
  tokenToAnsiForeground,
  tokenToCssHex,
} from "./index.js";

describe("brand color tokens", () => {
  it("resolves brand.primary through red.500 to its published hex", () => {
    expect(resolveColorToken("brand.primary")).toEqual({
      name: "red.500",
      hex: "#ff2056",
    });
    expect(tokenToCssHex("brand.primary")).toBe("#ff2056");
  });

  it("derives truecolor ANSI foreground and background escapes", () => {
    expect(tokenToAnsiForeground("brand.primary")).toBe("\u001B[38;2;255;32;86m");
    expect(tokenToAnsiBackground("brand.primary")).toBe("\u001B[48;2;255;32;86m");
  });

  it("throws a named error for a malformed token instead of choosing a fallback", () => {
    expect(() => tokenToCssHex("brand")).toThrowError(
      expect.objectContaining<Partial<BrandTokenError>>({
        name: "BrandTokenError",
        code: "TOKEN_MALFORMED",
        tokenName: "brand",
      }),
    );
  });

  it("throws the same named error type for a missing token", () => {
    expect(() => tokenToCssHex("does.not.exist")).toThrowError(
      expect.objectContaining<Partial<BrandTokenError>>({
        name: "BrandTokenError",
        code: "TOKEN_NOT_FOUND",
        tokenName: "does.not.exist",
      }),
    );
  });
});
