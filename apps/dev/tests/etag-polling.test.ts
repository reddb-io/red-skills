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
  snapshotCheckRuns,
} from "../src/core/etag-polling.js";
import { EtagPollingForwarder } from "../src/runtime/etag-transport.js";
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
