/**
 * config — the settings block, read into plain values.
 *
 * The reader takes a `SettingsSource` rather than reaching for
 * `vscode.workspace.getConfiguration` itself, so every default and every clamp is
 * exercised by a test that never opens a window. The editor supplies the real
 * source; a test supplies a record.
 */
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from "./watch/signals.js";

/** Whatever answers `get(key, fallback)` — `vscode.WorkspaceConfiguration` does. */
export interface SettingsSource {
  get<T>(key: string, fallback: T): T;
}

export interface ExtensionSettings {
  readonly socketPath: string;
  readonly pollIntervalMs: number;
  readonly renotifyMs: number;
  readonly notifications: NotificationPreferences;
}

/** The floor on polling: a faster loop reads the same host and spends the CPU twice. */
export const MIN_POLL_INTERVAL_MS = 500;

/** Read the whole block, clamping what an operator can set out of range. PURE. */
export function readSettings(source: SettingsSource): ExtensionSettings {
  return {
    socketPath: source.get<string>("socketPath", ""),
    pollIntervalMs: Math.max(MIN_POLL_INTERVAL_MS, source.get<number>("pollIntervalMs", 4_000)),
    renotifyMs: Math.max(0, source.get<number>("renotifyMs", 300_000)),
    notifications: {
      daemonReach: source.get("notifications.daemonReach", DEFAULT_NOTIFICATION_PREFERENCES.daemonReach),
      workerBirth: source.get("notifications.workerBirth", DEFAULT_NOTIFICATION_PREFERENCES.workerBirth),
      workerDeath: source.get("notifications.workerDeath", DEFAULT_NOTIFICATION_PREFERENCES.workerDeath),
      budgetPressure: source.get("notifications.budgetPressure", DEFAULT_NOTIFICATION_PREFERENCES.budgetPressure),
      budgetPressureAt: clampFraction(
        source.get("notifications.budgetPressureAt", DEFAULT_NOTIFICATION_PREFERENCES.budgetPressureAt),
      ),
      staleness: source.get("notifications.staleness", DEFAULT_NOTIFICATION_PREFERENCES.staleness),
      upgrade: source.get("notifications.upgrade", DEFAULT_NOTIFICATION_PREFERENCES.upgrade),
      pullRequests: source.get("notifications.pullRequests", DEFAULT_NOTIFICATION_PREFERENCES.pullRequests),
    },
  };
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_PREFERENCES.budgetPressureAt;
  return Math.min(1, Math.max(0, value));
}
