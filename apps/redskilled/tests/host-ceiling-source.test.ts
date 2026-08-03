// resolveHostCeiling describes its own answer honestly (#3077).
//
// The `source` field is interpolated into the admission reason, which speaks
// purely about memory — so labelling a DERIVED memory ceiling `declared`
// because a WORKER ceiling was stated told an operator debugging a denied
// Worker that they had stated a number they never stated.
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_MEMORY_CEILING_FRACTION,
  REDSKILLED_MEMORY_CEILING_ENV,
  REDSKILLED_WORKER_CEILING_ENV,
  resolveHostCeiling,
  setHostCeilingWarningSink,
} from "../src/admission.js";

const TOTAL = 16_000_000_000;
const FRACTION = Math.floor(TOTAL * DEFAULT_HOST_MEMORY_CEILING_FRACTION);

let restore: ((sink: (m: string) => void) => void) | null = null;
function captureWarnings(): string[] {
  const seen: string[] = [];
  const previous = setHostCeilingWarningSink((m) => seen.push(m));
  restore = () => setHostCeilingWarningSink(previous);
  return seen;
}
afterEach(() => {
  restore?.(() => undefined);
  restore = null;
});

describe("the source describes the memory ceiling", () => {
  it("is `declared` only when the MEMORY ceiling was stated", () => {
    const c = resolveHostCeiling({ [REDSKILLED_MEMORY_CEILING_ENV]: "8G" }, TOTAL);
    expect(c.source).toBe("declared");
  });

  it("is `host-fraction` when only the WORKER ceiling was stated", () => {
    // The defect: this used to answer `declared` about a derived number.
    const c = resolveHostCeiling({ [REDSKILLED_WORKER_CEILING_ENV]: "4" }, TOTAL);
    expect(c.source).toBe("host-fraction");
    expect(c.memory_bytes).toBe(FRACTION);
    expect(c.worker_count).toBe(4);
  });

  it("is `host-fraction` when nothing was stated", () => {
    expect(resolveHostCeiling({}, TOTAL).source).toBe("host-fraction");
  });
});

describe("a malformed ceiling is named, never obeyed in silence", () => {
  it("warns and falls back when the memory ceiling cannot be read", () => {
    const seen = captureWarnings();
    const c = resolveHostCeiling({ [REDSKILLED_MEMORY_CEILING_ENV]: "16GG" }, TOTAL);
    expect(c.memory_bytes).toBe(FRACTION);
    expect(c.source).toBe("host-fraction");
    expect(seen.join("\n")).toContain("16GG");
    expect(seen.join("\n")).toContain("Accepted forms");
  });

  it("names the risk direction — a mistyped percentage gets a LOOSER ceiling", () => {
    // `50%` mistyped falls back to 70%, which admits Workers past the line the
    // operator meant to draw. That is why silence was the wrong default.
    const seen = captureWarnings();
    const c = resolveHostCeiling({ [REDSKILLED_MEMORY_CEILING_ENV]: "50%%" }, TOTAL);
    expect(c.memory_bytes).toBeGreaterThan(Math.floor(TOTAL * 0.5));
    expect(seen).toHaveLength(1);
  });

  it("warns when the worker ceiling is not a positive integer", () => {
    const seen = captureWarnings();
    const c = resolveHostCeiling({ [REDSKILLED_WORKER_CEILING_ENV]: "many" }, TOTAL);
    expect(c.worker_count).toBeNull();
    expect(seen.join("\n")).toContain("many");
  });

  it("stays SILENT for infinity and its synonyms — those are declarations", () => {
    for (const word of ["infinity", "none", "off", "unbounded", "INFINITY"]) {
      const seen = captureWarnings();
      const c = resolveHostCeiling(
        { [REDSKILLED_MEMORY_CEILING_ENV]: word, [REDSKILLED_WORKER_CEILING_ENV]: word },
        TOTAL,
      );
      expect(c.memory_bytes, word).toBeNull();
      expect(c.worker_count, word).toBeNull();
      expect(seen, word).toEqual([]);
      restore?.(() => undefined);
    }
  });

  it("never fails the host over a bad env var", () => {
    captureWarnings();
    expect(() =>
      resolveHostCeiling({ [REDSKILLED_MEMORY_CEILING_ENV]: "🙂", [REDSKILLED_WORKER_CEILING_ENV]: "-3" }, TOTAL),
    ).not.toThrow();
  });
});
