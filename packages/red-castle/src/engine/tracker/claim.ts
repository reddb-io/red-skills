import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TRACKER_CLAIM_MARKER_VERSION = 1;

export type TrackerClaimKind = "claim" | "concede";
export type TrackerClaimLiveness = "alive" | "dead" | "unknown";
export type TrackerClaimVerdict = "won" | "lost";

export interface TrackerClaimIdentity {
  readonly worker: string;
  readonly runner?: string;
}

export interface TrackerClaimComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt?: string;
}

export interface TrackerClaimRecord {
  readonly commentId: number;
  readonly worker: string;
  readonly kind: TrackerClaimKind;
  readonly runner?: string;
  readonly createdAt?: string;
}

export interface TrackerClaimDecision {
  readonly verdict: TrackerClaimVerdict;
  readonly winner: string | null;
  readonly reason: string;
  readonly winnerClaimId?: number;
  readonly recovered: string[];
}

export interface TrackerClaimStore {
  postClaim(issue: number, body: string): Promise<number>;
  listClaims(issue: number): Promise<TrackerClaimComment[]>;
  concede(issue: number, body: string): Promise<void>;
}

export interface LocalIssueLeaseStore {
  acquire(
    issue: number,
    owner: string,
    liveness: (worker: string) => TrackerClaimLiveness,
  ): Promise<LocalLeaseDecision>;
  release(issue: number, owner: string): Promise<void>;
}

export type LocalLeaseDecision =
  | { readonly acquired: true; readonly previousOwner?: string }
  | {
      readonly acquired: false;
      readonly owner: string;
      readonly reason:
        "local lease owner is alive" | "local lease owner liveness unknown";
    };

export interface AcquireIssueLeaseOptions {
  readonly issue: number;
  readonly identity: TrackerClaimIdentity;
  readonly local: LocalIssueLeaseStore;
  readonly remote: TrackerClaimStore;
  readonly liveness: (worker: string) => TrackerClaimLiveness;
}

export interface RetireIssueLeaseOptions {
  readonly issue: number;
  readonly identity: TrackerClaimIdentity;
  readonly local: LocalIssueLeaseStore;
  readonly remote: TrackerClaimStore;
}

const MARKER_OPEN = "<!-- afk:claim";
const MARKER_RE = /<!--\s*afk:claim\s+([^>]*?)\s*-->/g;

function escapeField(value: string): string {
  return value.replace(/[\s>]/g, "_");
}

export function renderTrackerClaimComment(
  identity: TrackerClaimIdentity,
  kind: TrackerClaimKind = "claim",
): string {
  const fields = [
    `v${TRACKER_CLAIM_MARKER_VERSION}`,
    `worker=${escapeField(identity.worker)}`,
    `kind=${kind}`,
  ];
  if (identity.runner) fields.push(`runner=${escapeField(identity.runner)}`);
  const marker = `${MARKER_OPEN} ${fields.join(" ")} -->`;
  const human =
    kind === "claim"
      ? `AFK claim by worker \`${identity.worker}\`${identity.runner ? ` (runner \`${identity.runner}\`)` : ""}.`
      : `AFK worker \`${identity.worker}\` conceded this issue.`;
  return `${marker}\n${human}`;
}

export function parseTrackerClaimRecords(
  comments: readonly TrackerClaimComment[],
): TrackerClaimRecord[] {
  const out: TrackerClaimRecord[] = [];
  for (const comment of comments) {
    if (!Number.isFinite(comment.id) || typeof comment.body !== "string")
      continue;
    MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKER_RE.exec(comment.body)) !== null) {
      const fields = parseFields(match[1] ?? "");
      const worker = fields.get("worker");
      if (!worker) continue;
      const kind = fields.get("kind") === "concede" ? "concede" : "claim";
      out.push({
        commentId: comment.id,
        worker,
        kind,
        runner: fields.get("runner"),
        createdAt: fields.get("ts") ?? comment.createdAt,
      });
    }
  }
  return out;
}

function parseFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const token of raw.split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return fields;
}

export function reconcileTrackerClaims(
  records: readonly TrackerClaimRecord[],
  self: { readonly worker: string; readonly commentId: number },
  liveness: (worker: string) => TrackerClaimLiveness,
): TrackerClaimDecision {
  interface Fold {
    earliestClaimId: number | null;
    latestId: number;
    latestKind: TrackerClaimKind;
  }

  const folds = new Map<string, Fold>();
  const ingest = (record: TrackerClaimRecord): void => {
    if (!Number.isFinite(record.commentId) || record.worker === "") return;
    const existing = folds.get(record.worker);
    if (!existing) {
      folds.set(record.worker, {
        earliestClaimId: record.kind === "claim" ? record.commentId : null,
        latestId: record.commentId,
        latestKind: record.kind,
      });
      return;
    }
    if (
      record.kind === "claim" &&
      (existing.earliestClaimId === null ||
        record.commentId < existing.earliestClaimId)
    ) {
      existing.earliestClaimId = record.commentId;
    }
    if (record.commentId >= existing.latestId) {
      existing.latestId = record.commentId;
      existing.latestKind = record.kind;
    }
  };

  for (const record of records) ingest(record);
  ingest({ commentId: self.commentId, worker: self.worker, kind: "claim" });

  const contenders: Array<{ worker: string; claimId: number }> = [];
  const dead: Array<{ worker: string; claimId: number }> = [];
  for (const [worker, fold] of folds) {
    if (fold.latestKind === "concede" || fold.earliestClaimId === null)
      continue;
    const verdict = liveness(worker);
    if (verdict === "dead") {
      dead.push({ worker, claimId: fold.earliestClaimId });
      continue;
    }
    contenders.push({ worker, claimId: fold.earliestClaimId });
  }

  contenders.sort(
    (a, b) => a.claimId - b.claimId || a.worker.localeCompare(b.worker),
  );
  const winner = contenders[0];
  if (!winner) {
    return {
      verdict: "lost",
      winner: null,
      reason: "no live claim contends",
      recovered: [],
    };
  }

  const recovered =
    winner.worker === self.worker
      ? dead
          .filter((claim) => claim.claimId < winner.claimId)
          .map((claim) => claim.worker)
          .sort()
      : [];
  if (winner.worker === self.worker) {
    return {
      verdict: "won",
      winner: self.worker,
      winnerClaimId: winner.claimId,
      reason:
        contenders.length === 1
          ? "solo claim"
          : `earliest of ${contenders.length} live claims`,
      recovered,
    };
  }
  return {
    verdict: "lost",
    winner: winner.worker,
    winnerClaimId: winner.claimId,
    reason: `worker ${winner.worker} holds earlier claim`,
    recovered: [],
  };
}

export async function acquireIssueLease(
  options: AcquireIssueLeaseOptions,
): Promise<TrackerClaimDecision> {
  const local = await options.local.acquire(
    options.issue,
    options.identity.worker,
    options.liveness,
  );
  if (!local.acquired) {
    return {
      verdict: "lost",
      winner: local.owner,
      reason: local.reason,
      recovered: [],
    };
  }

  const commentId = await options.remote.postClaim(
    options.issue,
    renderTrackerClaimComment(options.identity, "claim"),
  );
  const records = parseTrackerClaimRecords(
    await options.remote.listClaims(options.issue),
  );
  const decision = reconcileTrackerClaims(
    records,
    { worker: options.identity.worker, commentId },
    options.liveness,
  );
  if (decision.verdict === "lost") {
    await options.remote.concede(
      options.issue,
      renderTrackerClaimComment(options.identity, "concede"),
    );
    await options.local.release(options.issue, options.identity.worker);
  }
  return decision;
}

export async function retireIssueLease(
  options: RetireIssueLeaseOptions,
): Promise<void> {
  await options.remote.concede(
    options.issue,
    renderTrackerClaimComment(options.identity, "concede"),
  );
  await options.local.release(options.issue, options.identity.worker);
}

export function createFsIssueLeaseStore(root: string): LocalIssueLeaseStore {
  return {
    acquire: (issue, owner, liveness) =>
      acquireFsIssueLease(root, issue, owner, liveness),
    release: (issue, owner) => releaseFsIssueLease(root, issue, owner),
  };
}

async function acquireFsIssueLease(
  root: string,
  issue: number,
  owner: string,
  liveness: (worker: string) => TrackerClaimLiveness,
): Promise<LocalLeaseDecision> {
  const leaseDir = issueLeaseDir(root, issue);
  try {
    await mkdir(leaseDir, { recursive: false });
    await writeFile(join(leaseDir, "owner"), `${owner}\n`, { flag: "wx" });
    return { acquired: true };
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== "ENOENT" &&
      (err as NodeJS.ErrnoException).code !== "EEXIST"
    ) {
      throw err;
    }
  }

  await mkdir(root, { recursive: true });
  try {
    await mkdir(leaseDir, { recursive: false });
    await writeFile(join(leaseDir, "owner"), `${owner}\n`, { flag: "wx" });
    return { acquired: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const currentOwner = await readLeaseOwner(leaseDir);
  if (currentOwner === owner) return { acquired: true };
  const verdict = currentOwner ? liveness(currentOwner) : "unknown";
  if (verdict !== "dead") {
    return {
      acquired: false,
      owner: currentOwner ?? "unknown",
      reason:
        verdict === "alive"
          ? "local lease owner is alive"
          : "local lease owner liveness unknown",
    };
  }

  await rm(leaseDir, { recursive: true, force: true });
  await mkdir(leaseDir, { recursive: false });
  await writeFile(join(leaseDir, "owner"), `${owner}\n`, { flag: "wx" });
  return { acquired: true, previousOwner: currentOwner };
}

async function releaseFsIssueLease(
  root: string,
  issue: number,
  owner: string,
): Promise<void> {
  const leaseDir = issueLeaseDir(root, issue);
  const currentOwner = await readLeaseOwner(leaseDir);
  if (currentOwner === owner) {
    await rm(leaseDir, { recursive: true, force: true });
  }
}

async function readLeaseOwner(leaseDir: string): Promise<string | undefined> {
  try {
    return (
      (await readFile(join(leaseDir, "owner"), "utf8")).trim() || undefined
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function issueLeaseDir(root: string, issue: number): string {
  return join(root, String(issue));
}
