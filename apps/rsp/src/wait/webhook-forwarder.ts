/**
 * webhook-forwarder.ts — supervised gh webhook forward child + delivery routing.
 *
 * The forwarder is an ACCELERATOR, not a truth source. It wakes active waits
 * early when a GitHub delivery matches their target, so the next probe fires
 * immediately instead of at the next poll tier. Probes remain the only path to
 * a verdict — a delivery can never flip an outcome by itself.
 *
 * Lifecycle
 * - start() spawns `gh webhook forward`. If the extension is absent or the
 *   command fails immediately, the forwarder silently stays in "polling" mode.
 * - On unexpected child exit the forwarder restarts, up to MAX_RESTARTS times
 *   with exponential backoff.
 * - stop() kills the child and marks the instance dead; restarts never fire
 *   after stop().
 *
 * Wake signals
 * - makeWakeSignalFor(kind, target) returns a factory `() => AbortSignal | undefined`.
 * - Each call to the factory creates a fresh AbortSignal that fires on the
 *   next delivery matching (kind, target), or returns undefined in polling mode.
 * - The factory is designed for repeated use inside pollUntilDone: each sleep
 *   cycle gets its own signal so the subscription renews automatically.
 *
 * Mode
 * - mode starts as "polling"; transitions to "webhook" on the first delivery
 *   received from the child's stdout.
 * - The transition is one-way within a wait's lifetime.
 */
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { terminateProcessTree } from "./process-tree.js";

export type WebhookMode = "webhook" | "polling";

/** Fields from a GitHub webhook payload that the forwarder routes on. */
export interface WebhookDelivery {
  pull_request?: { number?: number };
  check_run?: { pull_requests?: Array<{ number?: number }> };
  check_suite?: { pull_requests?: Array<{ number?: number }> };
  workflow_run?: { id?: number };
  [key: string]: unknown;
}

/**
 * Returns true when `delivery` is relevant to a PR wait for `prNumber`.
 * Covers three GitHub event families that signal PR check state:
 *   - pull_request (direct PR events)
 *   - check_run   (individual check-run updates linked to the PR)
 *   - check_suite (suite-level rollups linked to the PR)
 */
export function deliveryMatchesPr(delivery: WebhookDelivery, prNumber: string): boolean {
  const n = Number(prNumber);
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  if (delivery.pull_request?.number === n) return true;
  if (delivery.check_run?.pull_requests?.some((p) => p.number === n)) return true;
  if (delivery.check_suite?.pull_requests?.some((p) => p.number === n)) return true;
  return false;
}

/**
 * Returns true when `delivery` is relevant to a run wait for `runId`.
 * GitHub workflow_run events carry the numeric run id directly.
 */
export function deliveryMatchesRun(delivery: WebhookDelivery, runId: string): boolean {
  return delivery.workflow_run != null && String(delivery.workflow_run.id) === runId;
}

const GH_WEBHOOK_EVENTS = "pull_request,pull_request_review,check_run,check_suite,workflow_run";
const MAX_RESTARTS = 3;
const STOP_GRACE_MS = 1_000;

/** stderr patterns that indicate the extension is not installed → no restart. */
const NOT_INSTALLED_RE = /no extension matched|unknown command|command not found/i;

export interface WebhookForwarderOptions {
  cwd: string;
  /**
   * When this signal fires the forwarder is stopped. Pass the wait's own
   * cancellation signal so the forwarder is automatically cleaned up on timeout
   * or SIGTERM.
   */
  cancelSignal: AbortSignal;
  /** Override the gh binary path — intended for testing. */
  ghBin?: string;
}

export class WebhookForwarder extends EventEmitter {
  private child?: ChildProcess;
  private _dead = false;
  private restarts = 0;
  private _mode: WebhookMode = "polling";
  private stopping?: Promise<void>;

  constructor(private readonly opts: WebhookForwarderOptions) {
    super();
  }

  get mode(): WebhookMode {
    return this._mode;
  }

  get dead(): boolean {
    return this._dead;
  }

  /** Spawn the forwarder child and begin routing deliveries. */
  start(): void {
    if (this._dead || this.opts.cancelSignal.aborted) return;
    this.opts.cancelSignal.addEventListener("abort", () => void this.stop(), { once: true });
    this.spawnChild();
  }

  /** Kill the complete child tree, wait for proof, and prevent all future restarts. */
  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    this._dead = true;
    this.emit("stopped");
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    this.stopping = terminateProcessTree(child, STOP_GRACE_MS).then(() => undefined);
    await this.stopping;
  }

  /**
   * Returns a factory `() => AbortSignal | undefined` suitable for
   * `pollUntilDone`'s `makeWakeSignal` option.
   *
   * - In "polling" mode the factory returns undefined, so sleeps run at the
   *   normal backoff interval.
   * - In "webhook" mode each call creates a fresh AbortSignal that fires on
   *   the next delivery matching (kind, target). The signal unsubscribes itself
   *   automatically once it fires or the forwarder stops, so there are no leaks
   *   across multiple sleep cycles.
   */
  makeWakeSignalFor(kind: "pr" | "run", target: string): () => AbortSignal | undefined {
    return () => {
      if (this._mode !== "webhook" || this._dead) return undefined;
      const controller = new AbortController();

      const onDelivery = (d: WebhookDelivery) => {
        const match = kind === "pr" ? deliveryMatchesPr(d, target) : deliveryMatchesRun(d, target);
        if (!match) return;
        cleanup();
        controller.abort();
      };
      const onStopped = () => {
        cleanup();
        // Don't abort: forwarder going down falls back to full sleep interval.
      };
      const cleanup = () => {
        this.off("delivery", onDelivery);
        this.off("stopped", onStopped);
      };

      this.on("delivery", onDelivery);
      this.once("stopped", onStopped);
      return controller.signal;
    };
  }

  private spawnChild(): void {
    if (this._dead) return;
    const ghBin = this.opts.ghBin ?? "gh";
    let child: ChildProcess;
    try {
      child = spawn(ghBin, ["webhook", "forward", `--events=${GH_WEBHOOK_EVENTS}`], {
        cwd: this.opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch {
      return;
    }
    this.child = child;

    let lineBuffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      lineBuffer += chunk;
      let nl: number;
      while ((nl = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, nl).trim();
        lineBuffer = lineBuffer.slice(nl + 1);
        if (line) this.onLine(line);
      }
    });

    const stderrBufs: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBufs.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    });

    child.once("error", () => {
      if (this.child === child) this.child = undefined;
      this.scheduleRestart();
    });

    child.once("close", (code) => {
      if (this.child === child) this.child = undefined;
      if (this._dead) return;
      const stderr = Buffer.concat(stderrBufs).toString("utf8");
      if (NOT_INSTALLED_RE.test(stderr)) return;
      // gh exits 1 or 127 on "extension not found" before any restart: treat
      // as "not installed" so we degrade to polling instead of respawning.
      if (this.restarts === 0 && (code === 1 || code === 127)) return;
      this.scheduleRestart();
    });
  }

  private onLine(line: string): void {
    let delivery: WebhookDelivery;
    try {
      delivery = JSON.parse(line) as WebhookDelivery;
    } catch {
      return;
    }
    if (this._mode !== "webhook") {
      this._mode = "webhook";
      this.emit("mode-changed", "webhook" as WebhookMode);
    }
    this.emit("delivery", delivery);
  }

  private scheduleRestart(): void {
    if (this._dead || this.restarts >= MAX_RESTARTS) return;
    const delay = Math.min(500 * Math.pow(2, this.restarts), 5_000);
    this.restarts++;
    setTimeout(() => this.spawnChild(), delay).unref();
  }
}
