import { describe, expect, it, vi } from "vitest";
import { isGhRateLimited, withGhQuotaBackoff, type GhQuotaBackoffOpts } from "../src/runtime/gh/quota.js";
import type { ExecOutput } from "../src/runtime/exec.js";

// ---------- isGhRateLimited classifier ----------

describe("isGhRateLimited", () => {
  function out(code: number, stderr: string, stdout = ""): ExecOutput {
    return { code, stdout, stderr };
  }

  it("returns false when exit code is 0 (success)", () => {
    expect(isGhRateLimited(out(0, ""))).toBe(false);
  });

  it("returns false for a generic non-zero exit (auth error)", () => {
    expect(isGhRateLimited(out(1, "could not resolve host"))).toBe(false);
  });

  it("returns false for a 404 response", () => {
    expect(isGhRateLimited(out(1, "HTTP 404: Not Found"))).toBe(false);
  });

  it("returns false for a merge-conflict gh error", () => {
    expect(isGhRateLimited(out(1, "Pull request is not mergeable"))).toBe(false);
  });

  it("returns false for a bad-credentials auth failure", () => {
    expect(isGhRateLimited(out(1, "HTTP 401: Bad credentials"))).toBe(false);
  });

  // REST rate-limit shapes
  it("returns true for REST 403 primary rate-limit exceeded (stdout)", () => {
    expect(isGhRateLimited(out(1, "", "API rate limit exceeded for user ID 12345. Please wait before retrying."))).toBe(true);
  });

  it("returns true for REST 403 primary rate-limit exceeded (stderr)", () => {
    expect(isGhRateLimited(out(1, "HTTP 403: API rate limit exceeded"))).toBe(true);
  });

  it("returns true for REST 403 secondary rate-limit (abuse detection)", () => {
    expect(isGhRateLimited(out(1, "HTTP 403: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again."))).toBe(true);
  });

  it("returns true for REST 403 secondary rate-limit header phrase", () => {
    expect(isGhRateLimited(out(1, "You have exceeded a secondary rate limit and have been temporarily blocked from content creation."))).toBe(true);
  });

  it("returns true for REST 429 too many requests", () => {
    expect(isGhRateLimited(out(1, "HTTP 429: Too Many Requests"))).toBe(true);
  });

  // GraphQL rate-limit shapes
  it("returns true for GraphQL RATE_LIMITED type in errors", () => {
    const body = JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limited" }] });
    expect(isGhRateLimited(out(1, `GraphQL error: ${body}`))).toBe(true);
  });

  it("returns true for GraphQL 'API rate limited' phrase in stderr", () => {
    expect(isGhRateLimited(out(1, "GraphQL: API rate limited"))).toBe(true);
  });

  it("returns true for case-insensitive match", () => {
    expect(isGhRateLimited(out(1, "api rate limit exceeded"))).toBe(true);
  });
});

// ---------- withGhQuotaBackoff retry wrapper ----------

function fakeBackoff(opts?: Partial<GhQuotaBackoffOpts>): {
  opts: GhQuotaBackoffOpts;
  slept: number[];
  waited: number[];
  nowTick: () => void;
} {
  let now = 0;
  const slept: number[] = [];
  const waited: number[] = [];
  return {
    slept,
    waited,
    nowTick: () => { now += 61_000; }, // advance past default wait
    opts: {
      nowMs: () => now,
      sleepMs: async (ms) => {
        slept.push(ms);
        now += ms; // fake clock advances with each sleep
      },
      onWait: (r) => { waited.push(r); },
      defaultWaitMs: 60_000,
      capMs: 30 * 60 * 1000,
      ...opts,
    },
  };
}

function rateLimitedOutput(): ExecOutput {
  return { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" };
}

function successOutput(stdout = "ok"): ExecOutput {
  return { code: 0, stdout, stderr: "" };
}

describe("withGhQuotaBackoff", () => {
  it("returns success immediately when the first call succeeds", async () => {
    const { opts } = fakeBackoff();
    const fn = vi.fn(async () => successOutput("result"));
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r).toEqual({ code: 0, stdout: "result", stderr: "" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns non-quota failure immediately without retrying", async () => {
    const { opts } = fakeBackoff();
    const fn = vi.fn(async (): Promise<ExecOutput> => ({ code: 1, stdout: "", stderr: "merge conflict" }));
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r.code).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once after a rate-limit and returns the next result", async () => {
    const { opts, slept } = fakeBackoff();
    let call = 0;
    const fn = vi.fn(async (): Promise<ExecOutput> => {
      call++;
      return call === 1 ? rateLimitedOutput() : successOutput("landed");
    });
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r).toEqual({ code: 0, stdout: "landed", stderr: "" });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(slept.length).toBe(1);
  });

  it("calls onWait with remaining ms before each sleep", async () => {
    const { opts, waited } = fakeBackoff();
    let call = 0;
    const fn = vi.fn(async (): Promise<ExecOutput> => (++call === 1 ? rateLimitedOutput() : successOutput()));
    await withGhQuotaBackoff(fn, opts);
    expect(waited.length).toBe(1);
    expect(waited[0]).toBeGreaterThan(0);
  });

  it("sleeps for at most capMs when defaultWaitMs exceeds the cap", async () => {
    const { opts, slept } = fakeBackoff({ capMs: 5_000, defaultWaitMs: 60_000 });
    let call = 0;
    const fn = vi.fn(async (): Promise<ExecOutput> => (++call === 1 ? rateLimitedOutput() : successOutput()));
    await withGhQuotaBackoff(fn, opts);
    expect(slept[0]).toBe(5_000);
  });

  it("returns the rate-limit output without retrying when the cap is already exceeded", async () => {
    const { opts } = fakeBackoff({ capMs: 0 });
    const fn = vi.fn(async (): Promise<ExecOutput> => rateLimitedOutput());
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r.code).toBe(1);
    // Only one call: the initial one that triggered the rate-limit.
    // The cap is already 0 on the first check, so no retry fires.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries multiple times until success within the cap", async () => {
    const { opts, slept } = fakeBackoff({ defaultWaitMs: 1_000 });
    let call = 0;
    const fn = vi.fn(async (): Promise<ExecOutput> => (++call < 3 ? rateLimitedOutput() : successOutput("ok")));
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r.code).toBe(0);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(slept.length).toBe(2);
  });

  it("doubles the fallback wait each retry instead of hammering a fixed cadence (#3672)", async () => {
    const { opts, slept } = fakeBackoff({ capMs: 60 * 60_000, defaultWaitMs: 1_000 });
    let call = 0;
    const fn = vi.fn(async (): Promise<ExecOutput> => (++call < 5 ? rateLimitedOutput() : successOutput("ok")));
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r.code).toBe(0);
    // 1s, 2s, 4s, 8s — six Workers on a fixed 60s cadence produced ~9,000
    // retries in one evening; the doubling is what keeps a drained hour cheap.
    expect(slept).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it("sleeps to the probed reset instant when a probe is injected", async () => {
    const { opts, slept } = fakeBackoff({ capMs: 60 * 60_000, defaultWaitMs: 1_000 });
    const withProbe: GhQuotaBackoffOpts = { ...opts, probeResetMs: async () => opts.nowMs() + 30_000 };
    let call = 0;
    const fn = vi.fn(async (): Promise<ExecOutput> => (++call < 2 ? rateLimitedOutput() : successOutput("ok")));
    const r = await withGhQuotaBackoff(fn, withProbe);
    expect(r.code).toBe(0);
    // One sleep, aimed past the reset (probe + 5s margin), not a 60s hammer.
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThanOrEqual(30_000);
  });

  it("returns the rate-limit output after the cap is exhausted by sleeps", async () => {
    const { opts } = fakeBackoff({ capMs: 5_000, defaultWaitMs: 6_000 });
    // After the first sleep of 5000ms, the fake clock is at 5000ms → remaining = 0 → stop.
    const fn = vi.fn(async (): Promise<ExecOutput> => rateLimitedOutput());
    const r = await withGhQuotaBackoff(fn, opts);
    expect(r.code).toBe(1);
    expect(fn).toHaveBeenCalledTimes(2); // initial + one retry after the sleep
  });
});
