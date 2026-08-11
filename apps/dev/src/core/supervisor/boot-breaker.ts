import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import type { EnginePaths } from "@reddb-io/red-castle/engine";
import type { BootHaltError } from "../boot.js";

/** Consecutive identical boot-death signatures that trip the breaker (ADR 0122
 * amendment: crashloop circuit breaker). Overridable via RED_AFK_BOOT_BREAKER_K. */
export const BOOT_BREAKER_DEFAULT_THRESHOLD = 3;

export interface BootBreakerLedger {
  readonly version: 1;
  /** Fingerprint of the last boot death. */
  readonly signature: string;
  /** Consecutive occurrences of `signature`. A different signature or a
   * successful boot resets the run. */
  readonly count: number;
  /** Epoch seconds of the trip, or null while the breaker is closed. */
  readonly trippedAtEpoch: number | null;
  /** Epoch seconds of the last recorded death. */
  readonly updatedAtEpoch: number;
}

export interface BootBreakerStore {
  read(): Promise<BootBreakerLedger | null>;
  write(ledger: BootBreakerLedger | null): Promise<void>;
}

export interface BootBreakerDecision {
  readonly ledger: BootBreakerLedger;
  /** True when this death reached the threshold: stop respawning into the
   * failing configuration, invoke the healer, and alert. */
  readonly tripped: boolean;
}

/**
 * Fingerprint one boot death. Identical deterministic failures produce
 * byte-identical `phase|probeId|evidence` strings (the 2026-07-22 crashloop
 * emitted eight of these before a human noticed), while any change in the
 * offending issue/marker refs changes the evidence and thus the signature.
 */
export function bootDeathSignature(err: BootHaltError): string {
  if (err.probe) return `${err.phase}|${err.probe.id}|${err.probe.evidence}`;
  return `${err.phase}|${err.message}`;
}

/**
 * Record one boot death against the ledger. Pure: same signature increments the
 * consecutive run; a different signature restarts it at 1. The trip fires
 * exactly once, on the death that reaches the threshold — repeats past the
 * threshold keep counting but report `tripped: false` so the healer and alert
 * are not re-fired every subsequent death.
 */
export function recordBootDeath(
  prior: BootBreakerLedger | null,
  signature: string,
  nowEpoch: number,
  threshold: number = BOOT_BREAKER_DEFAULT_THRESHOLD,
): BootBreakerDecision {
  const consecutive = prior !== null && prior.signature === signature ? prior.count + 1 : 1;
  const alreadyTripped = prior !== null && prior.signature === signature && prior.trippedAtEpoch !== null;
  const trips = consecutive >= Math.max(1, threshold) && !alreadyTripped;
  return {
    ledger: {
      version: 1,
      signature,
      count: consecutive,
      trippedAtEpoch: alreadyTripped ? prior.trippedAtEpoch : trips ? nowEpoch : null,
      updatedAtEpoch: nowEpoch,
    },
    tripped: trips,
  };
}

/** True when the persisted ledger says the breaker is open — the watchdog must
 * not respawn a supervisor into the same failing configuration. */
export function isBreakerOpen(ledger: BootBreakerLedger | null): boolean {
  return ledger !== null && ledger.trippedAtEpoch !== null;
}

function validateLedger(value: unknown): BootBreakerLedger | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<BootBreakerLedger>;
  if (raw.version !== 1 || typeof raw.signature !== "string") return null;
  if (!Number.isSafeInteger(raw.count) || (raw.count as number) < 1) return null;
  const tripped = raw.trippedAtEpoch;
  if (tripped !== null && !Number.isSafeInteger(tripped)) return null;
  const updated = raw.updatedAtEpoch;
  if (!Number.isSafeInteger(updated)) return null;
  return {
    version: 1,
    signature: raw.signature,
    count: raw.count as number,
    trippedAtEpoch: (tripped ?? null) as number | null,
    updatedAtEpoch: updated as number,
  };
}

export function bootBreakerPath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "boot-breaker.toon");
}

/** TOON-on-disk store (log doctrine, ADR 0097). Writing `null` resets the
 * breaker by persisting an explicit closed sentinel — a successful boot must
 * clear a prior run even when the file cannot be deleted atomically. */
export function createFileBootBreakerStore(paths: EnginePaths): BootBreakerStore {
  const path = bootBreakerPath(paths);
  return {
    async read() {
      try {
        return validateLedger(decode(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        return null;
      }
    },
    async write(ledger) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
      const payload = ledger === null ? { version: 1, closed: true } : ledger;
      await writeFile(
        temporary,
        encode(payload as unknown as JsonValue),
        "utf8",
      );
      await rename(temporary, path);
    },
  };
}
