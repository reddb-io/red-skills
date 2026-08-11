// queue-custodian — the one owner of "this pull request ends merged"
// (ADR 0136, issue #3333).
//
// Landing gives this module an arm operation and the identity of the work. The
// native intent is established first and the durable record is written second:
// a record may therefore never claim custody of a PR the forge was not asked to
// merge. Detection and repair build on this same record rather than inventing a
// second queue inventory.

import {
  healQueueEjection,
  type QueueFailure,
  type RepairCandidate,
  type RepairLaneDeps,
  type RepairLaneResult,
} from "./repair-lane.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, type JsonValue } from "@reddb-io/toon";
import { serialize as encode } from "@reddb-io/toon/legacy";

export interface QueueCustodyIdentity {
  readonly repo: string;
  readonly prNumber: number;
  readonly ownerTicket: number;
  readonly branch: string;
  readonly base: string;
}

export interface QueueCustodyRecord extends QueueCustodyIdentity {
  readonly status: "watching" | "repairing" | "semantic-bounce" | "human";
  readonly semanticBounces: readonly QueueCustodyFailure[];
  readonly handedOffAt: string;
  readonly updatedAt: string;
}

export interface QueueCustodyFailure {
  readonly summary: string;
  readonly check?: string;
  readonly detailsUrl?: string;
  readonly observedAt: string;
}

export interface QueueCustodyState {
  readonly version: 1;
  readonly prs: Readonly<Record<string, QueueCustodyRecord>>;
}

export interface QueueCustodyStore {
  read(): Promise<QueueCustodyState>;
  write(state: QueueCustodyState): Promise<void>;
}

const EMPTY_CUSTODY: QueueCustodyState = { version: 1, prs: {} };

function decodeCustody(value: unknown): QueueCustodyState {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return EMPTY_CUSTODY;
  const root = value as { version?: unknown; prs?: unknown };
  if (root.version !== 1 || root.prs == null || typeof root.prs !== "object" || Array.isArray(root.prs)) {
    return EMPTY_CUSTODY;
  }
  const prs: Record<string, QueueCustodyRecord> = {};
  for (const [key, raw] of Object.entries(root.prs)) {
    if (!/^\d+$/.test(key) || raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Partial<QueueCustodyRecord>;
    if (
      !Number.isSafeInteger(record.prNumber) ||
      !Number.isSafeInteger(record.ownerTicket) ||
      typeof record.repo !== "string" ||
      typeof record.branch !== "string" ||
      typeof record.base !== "string" ||
      typeof record.handedOffAt !== "string" ||
      typeof record.updatedAt !== "string" ||
      !["watching", "repairing", "semantic-bounce", "human"].includes(record.status ?? "")
    ) continue;
    const semanticBounces = Array.isArray(record.semanticBounces)
      ? record.semanticBounces.filter((failure): failure is QueueCustodyFailure =>
          failure != null && typeof failure === "object" &&
          typeof (failure as Partial<QueueCustodyFailure>).summary === "string" &&
          typeof (failure as Partial<QueueCustodyFailure>).observedAt === "string")
      : [];
    prs[key] = {
      repo: record.repo,
      prNumber: record.prNumber as number,
      ownerTicket: record.ownerTicket as number,
      branch: record.branch,
      base: record.base,
      status: record.status as QueueCustodyRecord["status"],
      semanticBounces,
      handedOffAt: record.handedOffAt,
      updatedAt: record.updatedAt,
    };
  }
  return { version: 1, prs };
}

/** Atomic TOON store in the durable `.red/state/afk/` lane. */
export function createFileQueueCustodyStore(path: string): QueueCustodyStore {
  return {
    async read() {
      try {
        return decodeCustody(decode(await readFile(path, "utf8")));
      } catch {
        return EMPTY_CUSTODY;
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await writeFile(
        temporary,
        encode(decodeCustody(state) as unknown as JsonValue, { keyedMapCollapse: true }),
        "utf8",
      );
      await rename(temporary, path);
    },
  };
}

export interface QueueCustodyArmResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface QueueCustodyHandoffDeps {
  readonly store: QueueCustodyStore;
  readonly now: () => string;
  readonly armNativeIntent: () => Promise<QueueCustodyArmResult>;
  /** Test/telemetry seam invoked only after the atomic store write resolves. */
  readonly afterWrite?: (record: QueueCustodyRecord) => void | Promise<void>;
}

export interface QueueCustodyPullRequestView {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly nativeIntent: boolean;
  readonly checks: "green" | "pending" | "failing";
  readonly mergeStateStatus: string;
  readonly mergeable: string;
}

export interface QueueCustodyRepairAdmission extends QueueCustodyIdentity {
  readonly origin: "repair";
  readonly kind: "repair";
  readonly mergeStateStatus: string;
  readonly mergeable: string;
}

export interface QueueCustodySweepDeps {
  readonly store: QueueCustodyStore;
  readonly now: () => string;
  /** One budget-aware, batchable read for every open custody record. */
  readonly observePullRequests: (
    records: readonly QueueCustodyRecord[],
  ) => Promise<Readonly<Record<string, QueueCustodyPullRequestView>>>;
  /** The daemon's ordinary admission boundary; no private spawn is permitted. */
  readonly admitRepairWorker: (
    repair: QueueCustodyRepairAdmission,
  ) => Promise<{ readonly admitted: boolean; readonly workerId?: string }>;
}

export interface QueueCustodySweepResult {
  readonly merged: readonly number[];
  readonly admitted: readonly { readonly prNumber: number; readonly workerId: string }[];
}

export interface QueueCustodySemanticEvidence {
  readonly prNumber: number;
  readonly branch: string;
  readonly failure: QueueFailure;
  readonly history: readonly QueueCustodyFailure[];
}

export interface QueueCustodyRepairDeps {
  readonly store: QueueCustodyStore;
  readonly now: () => string;
  readonly repair: Omit<RepairLaneDeps, "attachQueueFailure" | "escalateOwner">;
  readonly adoptBranch: (ownerTicket: number, branch: string) => Promise<void>;
  readonly readyForAgent: (
    ownerTicket: number,
    evidence: QueueCustodySemanticEvidence,
  ) => Promise<void>;
  readonly readyForHuman: (
    ownerTicket: number,
    evidence: QueueCustodySemanticEvidence,
  ) => Promise<void>;
}

export type QueueCustodyRepairResult =
  | RepairLaneResult
  | { readonly outcome: "ready-for-agent"; readonly prNumber: number; readonly bounce: 1 }
  | { readonly outcome: "ready-for-human"; readonly prNumber: number; readonly bounce: number };

export type QueueCustodyHandoffResult =
  | { readonly ok: true; readonly prNumber: number; readonly outcome: "handed-off" }
  | { readonly ok: false; readonly prNumber: number; readonly outcome: "arm-failed"; readonly reason: string };

/** Arm GitHub's durable native intent, then persist the custody hand-off. */
export async function handoffQueueCustody(
  deps: QueueCustodyHandoffDeps,
  identity: QueueCustodyIdentity,
): Promise<QueueCustodyHandoffResult> {
  const armed = await deps.armNativeIntent();
  if (!armed.ok) {
    return {
      ok: false,
      prNumber: identity.prNumber,
      outcome: "arm-failed",
      reason: armed.reason?.trim() || "the native merge intent could not be armed",
    };
  }

  const now = deps.now();
  const state = await deps.store.read();
  const existing = state.prs[String(identity.prNumber)];
  const record: QueueCustodyRecord = {
    ...identity,
    status: "watching",
    semanticBounces: existing?.semanticBounces ?? [],
    handedOffAt: existing?.handedOffAt ?? now,
    updatedAt: now,
  };
  await deps.store.write({
    version: 1,
    prs: { ...state.prs, [String(identity.prNumber)]: record },
  });
  await deps.afterWrite?.(record);
  return { ok: true, prNumber: identity.prNumber, outcome: "handed-off" };
}

/**
 * One daemon sweep over durable custody. A live native intent remains entirely
 * GitHub's job. A vanished intent on an open PR crosses the host's normal
 * admission boundary exactly once and becomes visible as a repair Worker.
 */
export async function sweepQueueCustody(
  deps: QueueCustodySweepDeps,
): Promise<QueueCustodySweepResult> {
  const state = await deps.store.read();
  const watching = Object.values(state.prs).filter((record) => record.status === "watching");
  if (watching.length === 0) return { merged: [], admitted: [] };

  const views = await deps.observePullRequests(watching);
  const next = { ...state.prs };
  const merged: number[] = [];
  const admitted: { prNumber: number; workerId: string }[] = [];

  for (const record of watching) {
    const view = views[String(record.prNumber)];
    if (view == null) continue;
    if (view.state === "MERGED") {
      delete next[String(record.prNumber)];
      merged.push(record.prNumber);
      continue;
    }
    if (view.state !== "OPEN" || view.nativeIntent) continue;

    const birth = await deps.admitRepairWorker({
      ...record,
      origin: "repair",
      kind: "repair",
      mergeStateStatus: view.mergeStateStatus,
      mergeable: view.mergeable,
    });
    if (!birth.admitted || birth.workerId == null) continue;
    next[String(record.prNumber)] = {
      ...record,
      status: "repairing",
      updatedAt: deps.now(),
    };
    admitted.push({ prNumber: record.prNumber, workerId: birth.workerId });
  }

  if (merged.length > 0 || admitted.length > 0) {
    await deps.store.write({ version: 1, prs: next });
  }
  return { merged, admitted };
}

/**
 * Run one admission-born repair Worker. Mechanical recovery remains entirely in
 * the repair lane. Only its semantic verdict crosses back to the Ticket, with
 * branch adoption and a durable two-bounce history owned here.
 */
export async function repairQueueCustody(
  deps: QueueCustodyRepairDeps,
  candidate: RepairCandidate & QueueCustodyIdentity,
  generatorCommands: readonly string[],
): Promise<QueueCustodyRepairResult> {
  const result = await healQueueEjection(
    {
      ...deps.repair,
      attachQueueFailure: async () => undefined,
      escalateOwner: async () => undefined,
    },
    candidate,
    generatorCommands,
  );

  const state = await deps.store.read();
  const record = state.prs[String(candidate.prNumber)];
  if (record == null) return result;

  if (result.outcome !== "escalated") {
    await deps.store.write({
      version: 1,
      prs: {
        ...state.prs,
        [String(candidate.prNumber)]: {
          ...record,
          status: "watching",
          updatedAt: deps.now(),
        },
      },
    });
    return result;
  }

  const observedAt = deps.now();
  const failure: QueueCustodyFailure = { ...result.failure, observedAt };
  const history = [...record.semanticBounces, failure];
  const bounce = history.length;
  const status = bounce >= 2 ? "human" as const : "semantic-bounce" as const;
  await deps.store.write({
    version: 1,
    prs: {
      ...state.prs,
      [String(candidate.prNumber)]: {
        ...record,
        status,
        semanticBounces: history,
        updatedAt: observedAt,
      },
    },
  });

  const evidence: QueueCustodySemanticEvidence = {
    prNumber: candidate.prNumber,
    branch: candidate.branch,
    failure: result.failure,
    history,
  };
  await deps.adoptBranch(candidate.ownerTicket, candidate.branch);
  if (bounce >= 2) {
    await deps.readyForHuman(candidate.ownerTicket, evidence);
    return { outcome: "ready-for-human", prNumber: candidate.prNumber, bounce };
  }
  await deps.readyForAgent(candidate.ownerTicket, evidence);
  return { outcome: "ready-for-agent", prNumber: candidate.prNumber, bounce: 1 };
}
