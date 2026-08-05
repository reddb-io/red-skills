// queue-custodian — the one owner of "this pull request ends merged"
// (ADR 0136, issue #3333).
//
// Landing gives this module an arm operation and the identity of the work. The
// native intent is established first and the durable record is written second:
// a record may therefore never claim custody of a PR the forge was not asked to
// merge. Detection and repair build on this same record rather than inventing a
// second queue inventory.

export interface QueueCustodyIdentity {
  readonly repo: string;
  readonly prNumber: number;
  readonly ownerTicket: number;
  readonly branch: string;
  readonly base: string;
}

export interface QueueCustodyRecord extends QueueCustodyIdentity {
  readonly status: "watching";
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
