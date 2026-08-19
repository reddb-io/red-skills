import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readServedVersion,
  servedVersionPath,
  writeServedVersion,
} from "./served-version.js";

const home = (): string => mkdtempSync(join(tmpdir(), "served-version-"));

describe("the daemon's served-version pointer", () => {
  it("round-trips what the daemon says it serves", () => {
    const dir = home();
    writeServedVersion({ version: "3.21.0", observed_at: "2026-08-19T13:00:00.000Z", pid: 42 }, dir);
    expect(readServedVersion(dir)).toEqual({
      version: "3.21.0",
      observed_at: "2026-08-19T13:00:00.000Z",
      pid: 42,
    });
  });

  // Every failure is null: the caller's fallback is right for all of them, and a
  // throw would turn a missing optimisation into a broken launcher.
  it("answers null when no daemon ever wrote one", () => {
    expect(readServedVersion(home())).toBeNull();
  });

  it("answers null on a truncated or unreadable pointer", () => {
    const dir = home();
    writeServedVersion({ version: "3.21.0", observed_at: "x", pid: 1 }, dir);
    writeFileSync(servedVersionPath(dir), "vers");
    expect(readServedVersion(dir)).toBeNull();
  });

  it("answers null on a pointer that carries no version", () => {
    const dir = home();
    writeServedVersion({ version: "3.21.0", observed_at: "x", pid: 1 }, dir);
    writeFileSync(servedVersionPath(dir), "observed_at: x\npid: 1\n");
    expect(readServedVersion(dir)).toBeNull();
  });
});
