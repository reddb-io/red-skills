// etag-polling.test.ts — event ingestion via ETag conditional polling with a
// pluggable webhook transport (#2514, Spec #2511 slice 3).

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diffCheckRuns,
  nextPollDelayMs,
  parseConditionalResponse,
  rateLimitDelayMs,
  snapshotCheckRuns,
} from "../src/core/etag-polling.js";
import {
  ETAG_POLL_FLOOR_S,
  EtagPollingForwarder,
  EtagQuotaExhaustedError,
} from "../src/runtime/etag-transport.js";
import { createResidentWebhook, type ResidentWebhookForwarder } from "../src/resident-webhook.js";

function httpResponse(status: number, headers: Record<string, string>, body?: unknown): string {
  const head = [`HTTP/2.0 ${status} ${status === 304 ? "Not Modified" : "OK"}`]
    .concat(Object.entries(headers).map(([k, v]) => `${k}: ${v}`))
    .join("\r\n");
  return `${head}\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`;
}

describe("conditional response parsing + cadence", () => {
  it("parses status, etag, and X-Poll-Interval", () => {
    const parsed = parseConditionalResponse(
      httpResponse(200, { ETag: '"abc"', "X-Poll-Interval": "77" }, [{ id: "1" }]),
    );
    expect(parsed.status).toBe(200);
    expect(parsed.etag).toBe('"abc"');
    expect(parsed.pollIntervalS).toBe(77);
    expect(parsed.body).toEqual([{ id: "1" }]);
  });

  it("a 304 carries no body and produces no events downstream", () => {
    const parsed = parseConditionalResponse(httpResponse(304, { ETag: '"abc"' }));
    expect(parsed.status).toBe(304);
    expect(parsed.body).toBeUndefined();
  });

  it("the server's X-Poll-Interval wins over the floor when larger", () => {
    expect(nextPollDelayMs(120, 60)).toBe(120_000);
    expect(nextPollDelayMs(10, 60)).toBe(60_000);
    expect(nextPollDelayMs(undefined, 60)).toBe(60_000);
  });

  it("parses the rate-limit reset instant and the retry-after directive", () => {
    const parsed = parseConditionalResponse(
      httpResponse(403, { "X-RateLimit-Reset": "1700000900", "Retry-After": "120" }),
    );
    expect(parsed.status).toBe(403);
    expect(parsed.resetAtMs).toBe(1_700_000_900_000);
    expect(parsed.retryAfterS).toBe(120);
  });
});

describe("rate-limited pacing", () => {
  const CAP_MS = 30 * 60 * 1000;

  it("sleeps until the reset instant the response supplied", () => {
    expect(rateLimitDelayMs({ resetAtMs: 1_000_900_000 }, 1_000_000_000, 60, CAP_MS)).toBe(900_000);
  });

  it("honours retry-after when no reset instant is present", () => {
    expect(rateLimitDelayMs({ retryAfterS: 300 }, 1_000_000_000, 60, CAP_MS)).toBe(300_000);
  });

  it("stays bounded: never below the floor, never past the cap", () => {
    // A reset already in the past must not turn into a hot retry.
    expect(rateLimitDelayMs({ resetAtMs: 999_999_000 }, 1_000_000_000, 60, CAP_MS)).toBe(60_000);
    // A far-future reset is clamped so the wait cannot look like a hang.
    expect(rateLimitDelayMs({ resetAtMs: 9_000_000_000 }, 1_000_000_000, 60, CAP_MS)).toBe(CAP_MS);
    // No pacing at all falls back to the floor.
    expect(rateLimitDelayMs({}, 1_000_000_000, 60, CAP_MS)).toBe(60_000);
  });
});

describe("check-run snapshot diffing", () => {
  const completed = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });

  it("a check transition produces exactly one check.completed event", () => {
    const before = snapshotCheckRuns({ check_runs: [{ name: "test", status: "in_progress", conclusion: null }] });
    const after = snapshotCheckRuns({ check_runs: [completed("test", "success")] });
    expect(diffCheckRuns(42, before, after)).toEqual([
      { event: "check_run", action: "completed", pr: 42, check: "test", conclusion: "success" },
    ]);
    // Unchanged completed state re-diffed → no re-emission.
    expect(diffCheckRuns(42, after, after)).toEqual([]);
  });
});

describe("ETag polling transport", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("unchanged state (304) emits nothing; the second cycle sends If-None-Match", async () => {
    dir = mkdtempSync(join(tmpdir(), "etag-"));
    const calls: string[][] = [];
    const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "api" && String(args[2]).includes("/events")) {
        const conditional = args.includes("-H");
        return {
          code: 0,
          stdout: conditional
            ? httpResponse(304, { ETag: '"e1"' })
            : httpResponse(200, { ETag: '"e1"' }, []),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const forwarder = new EtagPollingForwarder({ root: dir, exec });
    const deliveries: unknown[] = [];
    forwarder.on("delivery", (d) => deliveries.push(d));

    await forwarder.pollOnce();
    await forwarder.pollOnce();

    expect(deliveries).toEqual([]);
    const second = calls.filter((args) => String(args[2]).includes("/events"))[1]!;
    expect(second).toContain("-H");
    expect(second.join(" ")).toContain('If-None-Match: "e1"');
  });

  it("a new repo event becomes one delivery, deduped by id across cycles", async () => {
    dir = mkdtempSync(join(tmpdir(), "etag-"));
    const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args[0] === "api" && String(args[2]).includes("/events")) {
        return {
          code: 0,
          stdout: httpResponse(200, { ETag: '"e2"' }, [
            { id: "9", type: "PullRequestEvent", payload: { action: "closed" } },
          ]),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const forwarder = new EtagPollingForwarder({ root: dir, exec });
    const deliveries: unknown[] = [];
    forwarder.on("delivery", (d) => deliveries.push(d));

    await forwarder.pollOnce();
    await forwarder.pollOnce();

    expect(deliveries).toEqual([
      { event: "PullRequestEvent", action: "closed", transport: "etag-polling", id: "9" },
    ]);
  });
});

describe("the poll loop's error path", () => {
  const NOW_MS = 1_700_000_000_000;
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Run exactly one loop cycle and report the delay it slept plus every
   * observed quota wait. The injected sleep stops the loop, so the recorded
   * delay is the loop's own scheduling decision, not a real wait. */
  async function oneCycle(exec: unknown): Promise<{ delayMs: number; quotaWaits: number[] }> {
    dir = mkdtempSync(join(tmpdir(), "etag-"));
    const delays: number[] = [];
    const quotaWaits: number[] = [];
    const halt: { fn: () => Promise<void> } = { fn: async () => undefined };
    const forwarder = new EtagPollingForwarder({
      root: dir,
      exec: exec as never,
      nowMs: () => NOW_MS,
      onQuotaWait: (ms) => quotaWaits.push(ms),
      sleep: async (ms) => {
        delays.push(ms);
        await halt.fn();
      },
    });
    halt.fn = () => forwarder.stop();
    forwarder.start();
    await vi.waitFor(() => expect(delays).toHaveLength(1));
    return { delayMs: delays[0]!, quotaWaits };
  }

  it("a rate-limited poll sleeps until the reset instant, not the floor", async () => {
    const resetAtS = Math.floor(NOW_MS / 1000) + 900;
    const exec = vi.fn(async () => ({
      code: 1,
      stdout: httpResponse(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAtS) }),
      stderr: "gh: API rate limit exceeded for user ID 1.",
    }));

    const { delayMs, quotaWaits } = await oneCycle(exec);

    expect(delayMs).toBe(900_000);
    expect(delayMs).not.toBe(ETAG_POLL_FLOOR_S * 1000);
    // The wait is announced, so a long sleep is not silence.
    expect(quotaWaits).toEqual([900_000]);
  });

  it("a rate-limited poll honours retry-after when no reset instant is present", async () => {
    const exec = vi.fn(async () => ({
      code: 1,
      stdout: httpResponse(403, { "Retry-After": "240" }),
      stderr: "gh: You have exceeded a secondary rate limit.",
    }));

    const { delayMs, quotaWaits } = await oneCycle(exec);

    expect(delayMs).toBe(240_000);
    expect(quotaWaits).toEqual([240_000]);
  });

  it("a generic transport fault keeps the floor-interval retry", async () => {
    const exec = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const { delayMs, quotaWaits } = await oneCycle(exec);

    expect(delayMs).toBe(ETAG_POLL_FLOOR_S * 1000);
    expect(quotaWaits).toEqual([]);
  });

  it("a not-modified poll costs no quota and still honours server-directed pacing", async () => {
    const exec = vi.fn(async (_cmd: string, args: readonly string[]) => {
      if (args[0] === "api") {
        return { code: 0, stdout: httpResponse(304, { ETag: '"e1"', "X-Poll-Interval": "90" }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const { delayMs, quotaWaits } = await oneCycle(exec);

    expect(delayMs).toBe(90_000);
    expect(quotaWaits).toEqual([]);
  });

  it("classifies a rate-limited exec output as its own fault, not a transport fault", () => {
    const error = new EtagQuotaExhaustedError({ resetAtMs: NOW_MS + 60_000 });
    expect(error).toBeInstanceOf(Error);
    expect(error.pacing.resetAtMs).toBe(NOW_MS + 60_000);
  });
});

describe("pluggable transport contract", () => {
  it("a test-double transport fills the same lane envelope as any other transport", async () => {
    const appended: Record<string, unknown>[] = [];
    const lane = {
      append: async (record: { singleton: string; kind: string; payload: Record<string, unknown> }) => {
        appended.push(record as unknown as Record<string, unknown>);
        return { seq: appended.length };
      },
    };
    const leases = {
      acquire: async () => ({ acquired: true }),
      release: async () => undefined,
    };
    class DoubleTransport extends EventEmitter implements ResidentWebhookForwarder {
      start(): void {
        this.emit("delivery", { event: "check_run", action: "completed", pr: 7, transport: "double" });
      }
      async stop(): Promise<void> {}
    }
    const webhook = createResidentWebhook({
      root: process.cwd(),
      leases: leases as never,
      lane: lane as never,
      makeForwarder: () => new DoubleTransport(),
      notice: () => undefined,
    });

    await webhook.start();
    await webhook.stop();

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      singleton: "github-webhook",
      kind: "github.webhook.delivery",
      payload: { event: "check_run", action: "completed", pr: 7, transport: "double" },
    });
  });
});
