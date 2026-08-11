import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@reddb-io/toon";
import { parse as decode, serialize as encode } from "@reddb-io/toon/legacy";
import type { EnginePaths } from "./paths.js";

export const HEAL_LEDGER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HEAL_LEDGER_QUARANTINE_AT = 3;

export interface HealLedgerState {
  readonly version: 1;
  readonly issues: Record<string, number[]>;
}

export interface HealLedgerStore {
  read(): Promise<HealLedgerState>;
  write(state: HealLedgerState): Promise<void>;
}

export interface HealLedgerDecision {
  readonly action: "heal" | "quarantine";
  readonly issue: number;
  readonly history: number[];
}

function validateState(value: unknown): HealLedgerState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("heal ledger state must be a record");
  }
  const raw = value as Partial<HealLedgerState>;
  if (raw.version !== 1 || !raw.issues || typeof raw.issues !== "object") {
    throw new Error("heal ledger state must be version 1 with issues");
  }
  const issues: Record<string, number[]> = {};
  for (const [issue, history] of Object.entries(raw.issues)) {
    if (!/^\d+$/.test(issue) || !Array.isArray(history)) continue;
    issues[issue] = history
      .filter((timestamp): timestamp is number => Number.isSafeInteger(timestamp) && timestamp >= 0)
      .sort((a, b) => a - b);
  }
  return { version: 1, issues };
}

export function healLedgerPath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "heal-ledger.toon");
}

export function createFileHealLedgerStore(paths: EnginePaths): HealLedgerStore {
  const path = healLedgerPath(paths);
  return {
    async read() {
      try {
        return validateState(decode(await readFile(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { version: 1, issues: {} };
        }
        throw error;
      }
    },
    async write(state) {
      const validated = validateState(state);
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await writeFile(
        temporary,
        encode(validated as unknown as JsonValue, { keyedMapCollapse: true }),
        "utf8",
      );
      await rename(temporary, path);
    },
  };
}

export async function recordIssueHeal(
  store: HealLedgerStore,
  issue: number,
  nowMs: number = Date.now(),
): Promise<HealLedgerDecision> {
  const state = await store.read();
  const key = String(issue);
  const threshold = nowMs - HEAL_LEDGER_WINDOW_MS;
  const history = [...(state.issues[key] ?? [])]
    .filter((timestamp) => timestamp >= threshold && timestamp <= nowMs)
    .concat(nowMs)
    .sort((a, b) => a - b);
  await store.write({
    version: 1,
    issues: { ...state.issues, [key]: history },
  });
  return {
    action: history.length >= HEAL_LEDGER_QUARANTINE_AT ? "quarantine" : "heal",
    issue,
    history,
  };
}
