import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  createEnginePaths,
  createFileMergeDriverStore,
} from "@reddb-io/red-castle/engine";
import { WebhookForwarder } from "@reddb-io/shared/github-webhook.js";
import type { ResidentWebhookForwarder } from "../resident-webhook.js";
import {
  diffCheckRuns,
  nextPollDelayMs,
  parseConditionalResponse,
  rateLimitDelayMs,
  snapshotCheckRuns,
  type CheckSnapshot,
  type RateLimitPacing,
} from "../core/etag-polling.js";
import { type ExecFn, execTool } from "./exec.js";
import { isGhRateLimited } from "./gh/quota.js";

export const ETAG_POLL_FLOOR_S = 60;
/** Upper bound on one quota wait — the same 30-minute cap the worker path's
 * `withGhQuotaBackoff` uses, so every quota wait in the process is bounded
 * alike. */
export const ETAG_QUOTA_WAIT_CAP_MS = 30 * 60 * 1000;

/**
 * A poll that GitHub refused for quota reasons, carrying whatever pacing the
 * response supplied. Distinct from a generic transport fault: the cure is to
 * sleep until the window resets, not to retry at the floor.
 */
export class EtagQuotaExhaustedError extends Error {
  readonly pacing: RateLimitPacing;

  constructor(pacing: RateLimitPacing) {
    super("github rate limit exhausted during conditional poll");
    this.name = "EtagQuotaExhaustedError";
    this.pacing = pacing;
  }
}

/** The pacing fields of a parsed response, without the undefined keys. */
function pacingOf(parsed: { resetAtMs?: number; retryAfterS?: number }): RateLimitPacing {
  return {
    ...(parsed.resetAtMs !== undefined ? { resetAtMs: parsed.resetAtMs } : {}),
    ...(parsed.retryAfterS !== undefined ? { retryAfterS: parsed.retryAfterS } : {}),
  };
}

export interface EtagPollingOptions {
  readonly root: string;
  readonly exec?: ExecFn;
  /** Poll floor in seconds; the server's X-Poll-Interval wins when larger. */
  readonly floorS?: number;
  /** True while a sibling webhook transport is live — polling then idles so
   * the two transports never double-emit. */
  readonly paused?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Current epoch in ms; injectable so quota waits are testable on a fake clock. */
  readonly nowMs?: () => number;
  /** Called before each quota wait with its length, so a long sleep is
   * observable rather than indistinguishable from a hang. */
  readonly onQuotaWait?: (waitMs: number) => void;
  /** Upper bound on a single quota wait (default {@link ETAG_QUOTA_WAIT_CAP_MS}). */
  readonly quotaWaitCapMs?: number;
}

/**
 * The ETag conditional-polling transport (#2514): one `ResidentWebhookForwarder`
 * implementation that fills the SAME delivery lane the `gh webhook forward`
 * child fills — consumers cannot tell the transports apart. Each cycle:
 *
 *   1. `repos/{slug}/events` with If-None-Match — 304 → nothing; 200 → one
 *      delivery per new event envelope.
 *   2. check-runs for every merge-driver-armed PR head — snapshot-diffed so a
 *      completed check emits exactly one `check.completed` delivery.
 */
export class EtagPollingForwarder extends EventEmitter implements ResidentWebhookForwarder {
  private dead = false;
  private etags = new Map<string, string>();
  private checkSnapshots = new Map<number, CheckSnapshot>();
  private seenEventIds = new Set<string>();

  constructor(private readonly options: EtagPollingOptions) {
    super();
  }

  start(): void {
    void this.loop();
  }

  async stop(): Promise<void> {
    this.dead = true;
  }

  private async loop(): Promise<void> {
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
    const floorS = this.options.floorS ?? ETAG_POLL_FLOOR_S;
    while (!this.dead) {
      let pollIntervalS: number | undefined;
      let quotaWaitMs: number | undefined;
      try {
        if (!this.options.paused?.()) {
          pollIntervalS = await this.pollOnce();
        }
      } catch (error) {
        if (error instanceof EtagQuotaExhaustedError) {
          // The quota is at zero: sleep until the window resets instead of
          // spending the floor cadence on requests that cannot succeed.
          quotaWaitMs = rateLimitDelayMs(
            error.pacing,
            (this.options.nowMs ?? Date.now)(),
            floorS,
            this.options.quotaWaitCapMs ?? ETAG_QUOTA_WAIT_CAP_MS,
          );
          this.options.onQuotaWait?.(quotaWaitMs);
        }
        // any other transport fault — retry after the floor.
      }
      await sleep(quotaWaitMs ?? nextPollDelayMs(pollIntervalS, floorS));
    }
  }

  /** One conditional poll cycle. Returns the server's X-Poll-Interval, if any. */
  async pollOnce(): Promise<number | undefined> {
    const exec = this.options.exec ?? execTool;
    const conditional = async (path: string): Promise<ReturnType<typeof parseConditionalResponse>> => {
      const etag = this.etags.get(path);
      const args = ["api", "-i", path, ...(etag ? ["-H", `If-None-Match: ${etag}`] : [])];
      const r = await exec("gh", args, { cwd: this.options.root });
      const parsed = parseConditionalResponse(r.stdout);
      // The quota taxonomy has one owner (`gh/quota.ts`); a rate limit is
      // raised as its own fault so the loop can pace on the reset instant.
      if (isGhRateLimited(r)) throw new EtagQuotaExhaustedError(pacingOf(parsed));
      if (parsed.etag) this.etags.set(path, parsed.etag);
      return parsed;
    };

    const events = await conditional("repos/{owner}/{repo}/events");
    if (events.status === 200 && Array.isArray(events.body)) {
      for (const event of events.body as { id?: string; type?: string; payload?: { action?: string } }[]) {
        const id = String(event.id ?? "");
        if (id !== "" && this.seenEventIds.has(id)) continue;
        if (id !== "") this.seenEventIds.add(id);
        this.emit("delivery", {
          event: String(event.type ?? "unknown"),
          action: String(event.payload?.action ?? ""),
          transport: "etag-polling",
          id,
        });
      }
      if (this.seenEventIds.size > 2000) {
        this.seenEventIds = new Set([...this.seenEventIds].slice(-1000));
      }
    }

    // Check-runs for merge-driver-armed PR heads: the PRs someone is actively
    // waiting on are exactly the ones whose check transitions matter.
    const store = createFileMergeDriverStore(createEnginePaths(join(this.options.root, ".red")));
    const state = await store.read();
    for (const record of Object.values(state.prs)) {
      if (record.status !== "armed") continue;
      const head = await exec(
        "gh",
        ["pr", "view", String(record.pr), "--json", "headRefOid", "--jq", ".headRefOid"],
        { cwd: this.options.root },
      );
      // A quota-exhausted head read means every later read in this cycle is
      // exhausted too — abort the cycle rather than spend the rest of it.
      if (isGhRateLimited(head)) throw new EtagQuotaExhaustedError({});
      const sha = head.stdout.trim();
      if (head.code !== 0 || sha === "") continue;
      const checks = await conditional(`repos/{owner}/{repo}/commits/${sha}/check-runs`);
      if (checks.status !== 200) continue;
      const next = snapshotCheckRuns(checks.body);
      const previous = this.checkSnapshots.get(record.pr) ?? {};
      for (const delivery of diffCheckRuns(record.pr, previous, next)) {
        this.emit("delivery", { ...delivery, transport: "etag-polling" });
      }
      this.checkSnapshots.set(record.pr, next);
    }

    return events.pollIntervalS;
  }
}

/**
 * Composite transport: the `gh webhook forward` child when available, with the
 * ETag poller as the always-armed fallback. The poller idles while the webhook
 * handshake holds (`mode === "webhook"`), so the two never double-emit; the
 * moment the webhook child dies or was never installed, polling resumes on the
 * next cycle with no consumer change — the pluggable-transport contract.
 */
export function createCompositeTransport(
  root: string,
  cancelSignal: AbortSignal,
  terminate: ConstructorParameters<typeof WebhookForwarder>[1],
): ResidentWebhookForwarder {
  const webhook = new WebhookForwarder({ cwd: root, cancelSignal }, terminate);
  const poller = new EtagPollingForwarder({
    root,
    paused: () => webhook.mode === "webhook" && !webhook.dead,
  });
  const composite = new EventEmitter() as EventEmitter & ResidentWebhookForwarder;
  webhook.on("delivery", (d) => composite.emit("delivery", d));
  webhook.on("malformed-delivery", (d) => composite.emit("malformed-delivery", d));
  poller.on("delivery", (d) => composite.emit("delivery", d));
  composite.start = () => {
    webhook.start();
    poller.start();
  };
  composite.stop = async () => {
    await Promise.all([webhook.stop(), poller.stop()]);
  };
  return composite;
}
