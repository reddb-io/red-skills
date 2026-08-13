import { describe, expect, it, vi } from "vitest";
import {
  TEST_PROCESS_MAX_LIFETIME_MS,
  armTestProcessLifetime,
} from "./support/test-process-lifetime.js";

describe("test-only process lifetime", () => {
  it("self-expires dispatcher and canary fixtures after 180 seconds", () => {
    const unref = vi.fn();
    const schedule = vi.fn<
      (callback: () => void, delayMs: number) => { unref(): unknown }
    >(() => ({ unref }));
    const exit = vi.fn();

    armTestProcessLifetime({ schedule, exit });

    expect(TEST_PROCESS_MAX_LIFETIME_MS).toBe(180_000);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 180_000);
    expect(unref).toHaveBeenCalledOnce();

    const expire = schedule.mock.calls[0]![0];
    expire();
    expect(exit).toHaveBeenCalledWith(124);
  });
});
