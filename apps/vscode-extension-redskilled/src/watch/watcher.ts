/**
 * watcher — the poll loop, with the editor kept on the outside.
 *
 * It owns exactly two things nothing pure can own: WHEN to read again, and the
 * memory of what the last read said. Everything it decides — which transitions
 * matter, which have already been announced — is delegated to `signals`, so the
 * loop can be driven a tick at a time by a test that never opens a window.
 *
 * A read that fails is a FRAME, not a fault: `readHostSnapshot` never throws, so
 * an unreachable daemon advances the loop and reaches the views like any other
 * answer. The loop therefore has no error path to get wrong, which is what keeps
 * a daemon restart from leaving the panels frozen on their last good frame.
 */
import type { HostSnapshot } from "../model/snapshot.js";
import {
  detectSignals,
  throttle,
  watchStateOf,
  type NotificationPreferences,
  type Signal,
  type WatchState,
} from "./signals.js";

export interface WatcherOptions {
  /** One read of the host; must resolve rather than reject. */
  readonly read: () => Promise<HostSnapshot>;
  readonly preferences: () => NotificationPreferences;
  readonly renotifyMs: () => number;
  /** Handed every frame, including unreachable ones. */
  readonly onSnapshot: (snapshot: HostSnapshot) => void;
  readonly onSignals: (signals: readonly Signal[]) => void;
  readonly now?: () => string;
}

export interface Watcher {
  /** Read once, right now, and settle everything the read implies. */
  tick(): Promise<HostSnapshot>;
  /** The last frame read, or `null` before the first tick. */
  latest(): HostSnapshot | null;
}

/**
 * A watcher with no timer of its own.
 *
 * Scheduling is the caller's, because an editor already owns one interval
 * primitive and a second one inside this module would be a lifetime nobody
 * disposes. `tick` is idempotent under overlap: a second call while a read is in
 * flight joins that read instead of starting a competing one.
 */
export function createWatcher(options: WatcherOptions): Watcher {
  const now = options.now ?? (() => new Date().toISOString());
  let previous: WatchState | null = null;
  let sentAt: Record<string, string> = {};
  let latest: HostSnapshot | null = null;
  let inFlight: Promise<HostSnapshot> | null = null;

  async function readOnce(): Promise<HostSnapshot> {
    const snapshot = await options.read();
    latest = snapshot;
    options.onSnapshot(snapshot);

    const current = watchStateOf(snapshot);
    const detected = detectSignals({
      previous,
      current,
      snapshot,
      preferences: options.preferences(),
    });
    previous = current;

    const kept = throttle(detected, sentAt, { renotifyMs: options.renotifyMs(), now: now() });
    sentAt = kept.sentAt;
    if (kept.signals.length > 0) options.onSignals(kept.signals);
    return snapshot;
  }

  return {
    async tick() {
      if (inFlight) return await inFlight;
      inFlight = readOnce().finally(() => {
        inFlight = null;
      });
      return await inFlight;
    },
    latest: () => latest,
  };
}
