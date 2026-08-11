import type { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
  type SingletonEventLane,
  type SingletonLeaseAcquireResult,
  type SingletonLeaseOwner,
  type SingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import {
  GITHUB_WEBHOOK_DELIVERY_KIND,
  GITHUB_WEBHOOK_SINGLETON,
} from "@reddb-io/shared/github-webhook.js";
import { resolveRepoRoot } from "@reddb-io/shared/repo-root.js";
import { readPidStartTime } from "./core/state.js";
import { createCompositeTransport } from "./runtime/etag-transport.js";
import { killTreeAndWait } from "./runtime/kill-tree.js";


export interface ResidentWebhookForwarder extends EventEmitter {
  start(): void;
  stop(): Promise<void>;
}

export interface ResidentWebhookOptions {
  readonly root: string;
  readonly owner?: SingletonLeaseOwner;
  readonly leases?: SingletonLeaseStore;
  readonly lane?: SingletonEventLane;
  readonly makeForwarder?: (
    root: string,
    cancelSignal: AbortSignal,
  ) => ResidentWebhookForwarder;
  readonly notice?: (message: string) => void;
}

export interface ResidentWebhook {
  start(): Promise<SingletonLeaseAcquireResult>;
  stop(): Promise<void>;
}

export function createResidentWebhook(
  options: ResidentWebhookOptions,
): ResidentWebhook {
  const root = resolveRepoRoot(options.root);
  const paths = createEnginePaths(join(root, ".red"));
  const owner = options.owner ?? {
    pid: process.pid,
    startTime: readPidStartTime(process.pid) ?? `pid-${process.pid}`,
  };
  const leases = options.leases ?? createSingletonLeaseStore(paths);
  const lane = options.lane ?? createSingletonEventLane(paths);
  const makeForwarder =
    options.makeForwarder ??
    // Composite transport (#2514): the `gh webhook forward` child when
    // available, with the ETag conditional poller as the always-armed fallback
    // filling the SAME lane — consumers never see which transport delivered.
    ((root: string, cancelSignal: AbortSignal) =>
      createCompositeTransport(root, cancelSignal, async (child, graceMs) => {
        if (!child.pid) return;
        const pollMs = 100;
        const graceTries = Math.max(1, Math.ceil(graceMs / pollMs));
        await killTreeAndWait(child.pid, { graceTries, pollMs });
      }));
  const notice =
    options.notice ??
    ((message: string) =>
      process.stderr.write(`redskilled MCP resident: ${message}\n`));
  const abort = new AbortController();
  let forwarder: ResidentWebhookForwarder | undefined;
  let ownsLease = false;
  const pendingAppends = new Set<Promise<void>>();

  return {
    async start() {
      const acquired = await leases.acquire(GITHUB_WEBHOOK_SINGLETON, owner);
      if (!acquired.acquired) return acquired;
      ownsLease = true;
      forwarder = makeForwarder(root, abort.signal);
      forwarder.on("delivery", (delivery: unknown) => {
        if (
          delivery === null ||
          typeof delivery !== "object" ||
          Array.isArray(delivery)
        ) {
          notice("dropped malformed GitHub webhook delivery");
          return;
        }
        const append = lane
          .append({
            singleton: GITHUB_WEBHOOK_SINGLETON,
            kind: GITHUB_WEBHOOK_DELIVERY_KIND,
            payload: delivery as Record<string, unknown>,
          })
          .then(() => undefined)
          .catch(() => {
            notice("failed to append GitHub webhook delivery");
          });
        pendingAppends.add(append);
        void append.finally(() => pendingAppends.delete(append));
      });
      forwarder.on("malformed-delivery", () => {
        notice("dropped malformed GitHub webhook delivery");
      });
      forwarder.start();
      return acquired;
    },

    async stop() {
      abort.abort();
      await forwarder?.stop();
      while (pendingAppends.size > 0) {
        await Promise.all([...pendingAppends]);
      }
      if (ownsLease) {
        await leases.release(GITHUB_WEBHOOK_SINGLETON, owner);
        ownsLease = false;
      }
    },
  };
}
