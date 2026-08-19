import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
  type SingletonEventLane,
  type SingletonLease,
  type SingletonLeaseStore,
} from "@reddb-io/worker/engine";
import {
  deliveryMatchesPr,
  deliveryMatchesRun,
  GITHUB_WEBHOOK_DELIVERY_KIND,
  GITHUB_WEBHOOK_SINGLETON,
  WebhookForwarder,
  type WebhookDelivery,
  type WebhookMode,
} from "./webhook-forwarder.js";
import { pidIdentityMatches } from "./process-tree.js";
import { resolveRepoRoot } from "@reddb-io/shared/repo-root.js";

export interface WebhookForwarderPort extends EventEmitter {
  mode: WebhookMode;
  start(): void;
  stop(): Promise<void>;
  makeWakeSignalFor(
    kind: "pr" | "run",
    target: string,
  ): () => AbortSignal | undefined;
}

export interface WebhookWakeSourceOptions {
  readonly cwd: string;
  readonly cancelSignal: AbortSignal;
  readonly leases?: SingletonLeaseStore;
  readonly lane?: SingletonEventLane;
  readonly makeForwarder?: (
    cwd: string,
    cancelSignal: AbortSignal,
  ) => WebhookForwarderPort;
  readonly isLeaseHolderLive?: (lease: SingletonLease) => Promise<boolean>;
  readonly pollIntervalMs?: number;
}

interface ResolvedWebhookWakeSourceOptions extends WebhookWakeSourceOptions {
  readonly leases: SingletonLeaseStore;
  readonly lane: SingletonEventLane;
  readonly makeForwarder: (
    cwd: string,
    cancelSignal: AbortSignal,
  ) => WebhookForwarderPort;
  readonly isLeaseHolderLive: (lease: SingletonLease) => Promise<boolean>;
}

export interface WebhookWakeSource extends EventEmitter {
  readonly mode: WebhookMode;
  start(): Promise<void>;
  stop(): Promise<void>;
  makeWakeSignalFor(
    kind: "pr" | "run",
    target: string,
  ): () => AbortSignal | undefined;
}

class SharedWebhookWakeSource
  extends EventEmitter
  implements WebhookWakeSource
{
  private _mode: WebhookMode = "polling";
  private cursor = 0;
  private timer: NodeJS.Timeout | undefined;
  private fallback: WebhookForwarderPort | undefined;
  private stopped = false;
  private syncing = false;

  constructor(private readonly options: ResolvedWebhookWakeSourceOptions) {
    super();
  }

  get mode(): WebhookMode {
    return this.fallback?.mode ?? this._mode;
  }

  async start(): Promise<void> {
    const lease = await this.options.leases
      .read(GITHUB_WEBHOOK_SINGLETON)
      .catch(() => undefined);
    if (!lease || !(await this.options.isLeaseHolderLive(lease))) {
      this.startFallback();
      return;
    }
    const events = await this.options.lane.read().catch(() => undefined);
    if (!events) {
      this.degradeToFallback();
      return;
    }
    this.cursor = events.length;
    this._mode = "webhook";
    this.emit("mode-changed", "webhook" as WebhookMode);
    this.timer = setInterval(
      () => void this.sync().catch(() => this.degradeToFallback()),
      this.options.pollIntervalMs ?? 100,
    );
    this.timer.unref();
    this.options.cancelSignal.addEventListener(
      "abort",
      () => void this.stop(),
      { once: true },
    );
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.fallback?.stop();
    this.emit("stopped");
  }

  makeWakeSignalFor(
    kind: "pr" | "run",
    target: string,
  ): () => AbortSignal | undefined {
    return () => {
      if (this.fallback) {
        return this.fallback.makeWakeSignalFor(kind, target)();
      }
      if (this._mode !== "webhook" || this.stopped) return undefined;
      const controller = new AbortController();
      const onDelivery = (delivery: WebhookDelivery) => {
        const matches =
          kind === "pr"
            ? deliveryMatchesPr(delivery, target)
            : deliveryMatchesRun(delivery, target);
        if (!matches) return;
        cleanup();
        controller.abort();
      };
      const cleanup = () => {
        this.off("delivery", onDelivery);
        this.off("stopped", cleanup);
      };
      this.on("delivery", onDelivery);
      this.once("stopped", cleanup);
      return controller.signal;
    };
  }

  private startFallback(): void {
    if (this.fallback || this.stopped) return;
    this.fallback = this.options.makeForwarder(
      this.options.cwd,
      this.options.cancelSignal,
    );
    this.fallback.on("mode-changed", (mode: WebhookMode) => {
      this.emit("mode-changed", mode);
    });
    this.fallback.on("delivery", (delivery: WebhookDelivery) => {
      this.emit("delivery", delivery);
    });
    this.fallback.start();
  }

  private degradeToFallback(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this._mode = "polling";
    this.startFallback();
  }

  private async sync(): Promise<void> {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      const events = await this.options.lane.read();
      if (events.length < this.cursor) this.cursor = 0;
      const unseen = events.slice(this.cursor);
      this.cursor = events.length;
      for (const event of unseen) {
        if (
          event.singleton === GITHUB_WEBHOOK_SINGLETON &&
          event.kind === GITHUB_WEBHOOK_DELIVERY_KIND &&
          event.payload
        ) {
          this.emit("delivery", event.payload as WebhookDelivery);
        }
      }
      const lease = await this.options.leases.read(GITHUB_WEBHOOK_SINGLETON);
      if (!lease || !(await this.options.isLeaseHolderLive(lease))) {
        this.degradeToFallback();
      }
    } finally {
      this.syncing = false;
    }
  }
}

export function createWebhookWakeSource(
  options: WebhookWakeSourceOptions,
): WebhookWakeSource {
  const root = resolveRepoRoot(options.cwd);
  const paths = createEnginePaths(join(root, ".red"));
  return new SharedWebhookWakeSource({
    ...options,
    leases: options.leases ?? createSingletonLeaseStore(paths),
    lane: options.lane ?? createSingletonEventLane(paths),
    makeForwarder:
      options.makeForwarder ??
      ((cwd, cancelSignal) => new WebhookForwarder({ cwd, cancelSignal })),
    isLeaseHolderLive:
      options.isLeaseHolderLive ??
      ((lease) => pidIdentityMatches(lease.pid, lease.start_time)),
  });
}
