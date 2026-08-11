import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@reddb-io/toon";
import { parse as decode, serialize as encode } from "@reddb-io/toon/legacy";
import type { EnginePaths } from "./paths.js";

/**
 * Merge driver (Spec #2511 slice 1, #2512): the castle-owned loop that lands
 * armed PRs without GitHub's native auto-merge. It productizes the hand-rolled
 * 2026-07-22 reconcilers — update-branch when BEHIND, merge (merge-commit
 * strategy, never an admin override) once green at head, bounded retries, and
 * a terminal classification (`needs-medic` / `needs-human`) instead of an
 * infinite loop on a PR that cannot land mechanically.
 */

/** Passes an armed PR may consume before the driver classifies it terminal —
 * mirrors the ~25-cycle bound of the hand-rolled reconcilers. */
export const MERGE_DRIVER_MAX_ATTEMPTS = 25;

export type MergeDriverStatus =
  | "armed"
  | "merged"
  | "needs-medic"
  | "needs-human"
  | "released";

export interface MergeDriverPrRecord {
  readonly pr: number;
  readonly status: MergeDriverStatus;
  readonly armedAtEpoch: number;
  /** Driver passes consumed while armed. */
  readonly attempts: number;
  readonly updatedAtEpoch: number;
  /** Last observed `state/mergeStateStatus/checks` triple, for observability. */
  readonly lastState?: string;
  /** Human-readable reason for a terminal classification. */
  readonly note?: string;
}

export interface MergeDriverState {
  readonly version: 1;
  readonly prs: Record<string, MergeDriverPrRecord>;
}

export interface MergeDriverStore {
  read(): Promise<MergeDriverState>;
  write(state: MergeDriverState): Promise<void>;
}

/** One armed PR's observable ground truth, read fresh each pass. */
export interface MergeDriverPrView {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  /** GitHub mergeStateStatus vocabulary (BEHIND/CLEAN/UNSTABLE/DIRTY/BLOCKED/…). */
  readonly mergeStateStatus: string;
  readonly checks: "green" | "pending" | "failing";
}

export interface MergeDriverIo {
  viewPr(pr: number): Promise<MergeDriverPrView>;
  /** PUT /pulls/{n}/update-branch. */
  updateBranch(pr: number): Promise<void>;
  /** Merge via the API with the given strategy. The driver only ever passes
   * "merge" — the merge-commit strategy — and there is deliberately NO
   * admin-override parameter in this port. */
  merge(pr: number, strategy: "merge"): Promise<void>;
}

export type MergeDriverAction =
  | "merged"
  | "already-merged"
  | "updated-branch"
  | "waiting"
  | "terminal-medic"
  | "terminal-human"
  | "retrying";

export interface MergeDriverPassEntry {
  readonly pr: number;
  readonly action: MergeDriverAction;
  readonly note?: string;
}

function validateState(value: unknown): MergeDriverState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, prs: {} };
  }
  const raw = value as Partial<MergeDriverState>;
  if (raw.version !== 1 || !raw.prs || typeof raw.prs !== "object") {
    return { version: 1, prs: {} };
  }
  const prs: Record<string, MergeDriverPrRecord> = {};
  for (const [key, record] of Object.entries(raw.prs)) {
    if (!/^\d+$/.test(key) || !record || typeof record !== "object") continue;
    const r = record as Partial<MergeDriverPrRecord>;
    if (!Number.isSafeInteger(r.pr) || typeof r.status !== "string") continue;
    prs[key] = {
      pr: r.pr as number,
      status: r.status as MergeDriverStatus,
      armedAtEpoch: Number.isSafeInteger(r.armedAtEpoch) ? (r.armedAtEpoch as number) : 0,
      attempts: Number.isSafeInteger(r.attempts) ? (r.attempts as number) : 0,
      updatedAtEpoch: Number.isSafeInteger(r.updatedAtEpoch) ? (r.updatedAtEpoch as number) : 0,
      ...(typeof r.lastState === "string" ? { lastState: r.lastState } : {}),
      ...(typeof r.note === "string" ? { note: r.note } : {}),
    };
  }
  return { version: 1, prs };
}

export function mergeDriverPath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "merge-driver.toon");
}

/** TOON-on-disk store (log doctrine, ADR 0097). Durable across resident
 * restarts — the armed set reloads from disk on every pass. */
export function createFileMergeDriverStore(paths: EnginePaths): MergeDriverStore {
  const path = mergeDriverPath(paths);
  return {
    async read() {
      try {
        return validateState(decode(await readFile(path, "utf8")));
      } catch {
        return { version: 1, prs: {} };
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await writeFile(
        temporary,
        encode(validateState(state) as unknown as JsonValue, { keyedMapCollapse: true }),
        "utf8",
      );
      await rename(temporary, path);
    },
  };
}

/** Arm one PR: it joins the driver's durable armed set. Re-arming a terminal
 * or released PR resets its record (fresh attempts budget). */
export async function armPr(
  store: MergeDriverStore,
  pr: number,
  nowEpoch: number,
): Promise<MergeDriverPrRecord> {
  const state = await store.read();
  const record: MergeDriverPrRecord = {
    pr,
    status: "armed",
    armedAtEpoch: nowEpoch,
    attempts: 0,
    updatedAtEpoch: nowEpoch,
  };
  await store.write({ version: 1, prs: { ...state.prs, [String(pr)]: record } });
  return record;
}

/** Release one PR: the driver stops owning it. The record is kept (status
 * `released`) for observability rather than deleted. */
export async function releasePr(
  store: MergeDriverStore,
  pr: number,
  nowEpoch: number,
): Promise<MergeDriverPrRecord | null> {
  const state = await store.read();
  const existing = state.prs[String(pr)];
  if (!existing) return null;
  const record: MergeDriverPrRecord = { ...existing, status: "released", updatedAtEpoch: nowEpoch };
  await store.write({ version: 1, prs: { ...state.prs, [String(pr)]: record } });
  return record;
}

/**
 * Run one driver pass over every ARMED PR. Per PR:
 *
 *   - MERGED on the tracker → record `merged` (goal reached, native auto-merge
 *     not required).
 *   - CLOSED without merge → terminal `needs-human`.
 *   - DIRTY → terminal `needs-medic`, never retried in a loop — a merge
 *     conflict is never healed by waiting.
 *   - failing checks → terminal `needs-medic`.
 *   - BEHIND with checks not failing → `updateBranch` once this pass, then wait.
 *   - CLEAN/UNSTABLE with green checks → `merge(pr, "merge")` — the
 *     merge-commit strategy; the port has no admin override by construction.
 *   - anything else (BLOCKED + pending checks, UNKNOWN) → wait.
 *   - view/update/merge transport errors → bounded retry via the attempts
 *     budget; exceeding `maxAttempts` classifies terminal `needs-human`.
 */
export async function runMergeDriverPass(
  io: MergeDriverIo,
  store: MergeDriverStore,
  options: { nowEpoch: number; maxAttempts?: number },
): Promise<MergeDriverPassEntry[]> {
  const maxAttempts = options.maxAttempts ?? MERGE_DRIVER_MAX_ATTEMPTS;
  const state = await store.read();
  const entries: MergeDriverPassEntry[] = [];
  const next: Record<string, MergeDriverPrRecord> = { ...state.prs };

  for (const record of Object.values(state.prs)) {
    if (record.status !== "armed") continue;
    const stamp = (patch: Partial<MergeDriverPrRecord>): MergeDriverPrRecord => {
      const updated: MergeDriverPrRecord = {
        ...record,
        ...patch,
        updatedAtEpoch: options.nowEpoch,
      };
      next[String(record.pr)] = updated;
      return updated;
    };

    const attempts = record.attempts + 1;
    if (attempts > maxAttempts) {
      stamp({ status: "needs-human", attempts, note: `attempts bound (${maxAttempts}) exhausted` });
      entries.push({ pr: record.pr, action: "terminal-human", note: "attempts bound exhausted" });
      continue;
    }

    let view: MergeDriverPrView;
    try {
      view = await io.viewPr(record.pr);
    } catch (error) {
      stamp({ attempts, note: `view failed: ${error instanceof Error ? error.message : String(error)}` });
      entries.push({ pr: record.pr, action: "retrying", note: "view failed" });
      continue;
    }
    const lastState = `${view.state}/${view.mergeStateStatus}/${view.checks}`;

    if (view.state === "MERGED") {
      stamp({ status: "merged", attempts, lastState });
      entries.push({ pr: record.pr, action: "already-merged" });
      continue;
    }
    if (view.state === "CLOSED") {
      stamp({ status: "needs-human", attempts, lastState, note: "closed without merge" });
      entries.push({ pr: record.pr, action: "terminal-human", note: "closed without merge" });
      continue;
    }
    if (view.mergeStateStatus === "DIRTY") {
      stamp({ status: "needs-medic", attempts, lastState, note: "merge conflict" });
      entries.push({ pr: record.pr, action: "terminal-medic", note: "merge conflict" });
      continue;
    }
    if (view.checks === "failing") {
      stamp({ status: "needs-medic", attempts, lastState, note: "failing checks" });
      entries.push({ pr: record.pr, action: "terminal-medic", note: "failing checks" });
      continue;
    }
    if (view.mergeStateStatus === "BEHIND") {
      try {
        await io.updateBranch(record.pr);
        stamp({ attempts, lastState });
        entries.push({ pr: record.pr, action: "updated-branch" });
      } catch (error) {
        stamp({ attempts, lastState, note: `update-branch failed: ${error instanceof Error ? error.message : String(error)}` });
        entries.push({ pr: record.pr, action: "retrying", note: "update-branch failed" });
      }
      continue;
    }
    if (
      (view.mergeStateStatus === "CLEAN" || view.mergeStateStatus === "UNSTABLE") &&
      view.checks === "green"
    ) {
      try {
        await io.merge(record.pr, "merge");
        stamp({ status: "merged", attempts, lastState });
        entries.push({ pr: record.pr, action: "merged" });
      } catch (error) {
        stamp({ attempts, lastState, note: `merge failed: ${error instanceof Error ? error.message : String(error)}` });
        entries.push({ pr: record.pr, action: "retrying", note: "merge failed" });
      }
      continue;
    }
    stamp({ attempts, lastState });
    entries.push({ pr: record.pr, action: "waiting" });
  }

  await store.write({ version: 1, prs: next });
  return entries;
}
