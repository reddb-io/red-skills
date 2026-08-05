import { describe, expect, it } from "vitest";
import {
  computeNextVersion,
  type PendingBumpSummary,
  type ReleaseClock,
} from "../src/version-core.js";

const PATCH: PendingBumpSummary = { major: 0, minor: 0, patch: 1 };

function clock(year: number, month: number): ReleaseClock {
  return { today: () => ({ year, month }) };
}

describe("semver release versions", () => {
  it.each([
    [{ major: 1, minor: 3, patch: 8 }, "1.2.3", "2.0.0"],
    [{ major: 0, minor: 2, patch: 8 }, "1.2.3", "1.3.0"],
    [{ major: 0, minor: 0, patch: 8 }, "1.2.3", "1.2.4"],
  ] satisfies readonly (readonly [PendingBumpSummary, string, string])[])(
    "uses the highest pending bump in %#",
    (pending, currentVersion, expected) => {
      expect(
        computeNextVersion({
          currentVersion,
          pending,
          scheme: "semver",
          clock: clock(2040, 12),
        }),
      ).toBe(expected);
    },
  );
});

describe("YYYY.M.MICRO calver release versions", () => {
  it("increments MICRO within the injected clock month", () => {
    expect(
      computeNextVersion({
        currentVersion: "2026.8.2",
        pending: { major: 1, minor: 0, patch: 0 },
        scheme: "calver",
        clock: clock(2026, 8),
      }),
    ).toBe("2026.8.3");
  });

  it("rolls to MICRO zero without leading zeroes when the injected month changes", () => {
    expect(
      computeNextVersion({
        currentVersion: "2026.8.9",
        pending: PATCH,
        scheme: "calver",
        clock: clock(2026, 9),
      }),
    ).toBe("2026.9.0");
  });
});

describe("release candidates", () => {
  it("derives rc.1 from the same pending semver release", () => {
    expect(
      computeNextVersion({
        currentVersion: "1.2.3",
        pending: { major: 0, minor: 1, patch: 2 },
        scheme: "semver",
        clock: clock(2026, 8),
        prerelease: "rc",
      }),
    ).toBe("1.3.0-rc.1");
  });

  it("increments rc.N without applying the pending bump twice", () => {
    expect(
      computeNextVersion({
        currentVersion: "1.3.0-rc.4",
        pending: { major: 0, minor: 1, patch: 2 },
        scheme: "semver",
        clock: clock(2026, 8),
        prerelease: "rc",
      }),
    ).toBe("1.3.0-rc.5");
  });
});

