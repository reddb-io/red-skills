/**
 * verdict-ledger — the durable record of who judged what, at which head.
 *
 * ADR 0154 makes landing conditional on a verdict written by an identity that
 * did not implement the change, pinned to the exact head being merged. That
 * authorization has to outlive the workspace that produced it, so it cannot be
 * the per-command `validation.jsonl` sidecar: a gate artifact is rewritten on
 * every write, carries no PR and no SHA, and disappears with the Worker.
 *
 * So the ledger is its own TOONL lane in the durable Castle state tier,
 * `.red/state/castle/verdicts.toonl`, and it is **append-only**. A row is never
 * edited and never removed: superseding a standing verdict means appending a
 * `voided` row for the same key. A ledger a writer can rewrite is a ledger an
 * auditor cannot trust, and the reader this lane exists for is the morning
 * human asking what was judged rather than re-reading diffs.
 *
 * The key is `(pr, head_sha, patch_id)`. The PR alone is not enough — the head
 * moves between gate-green and merge, which is the whole gap ADR 0154 closes —
 * and the patch id carries the equivalence a clean rebase preserves.
 *
 * This lane is new and carries no ADR 0098 sidecar exemption: TOONL, period.
 * Its ceiling lives in `LANE_RETENTION_REGISTRY["verdicts"]` rather than beside
 * the append below, because a bound only the writer knows is one the census
 * cannot audit (#3645).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LANE_RETENTION_REGISTRY,
  laneOverCeiling,
  trimLaneKeepLast,
  type LaneRetentionPolicy,
} from "@reddb-io/shared/lane-retention.js";
import { castleStateDir } from "@reddb-io/shared/red-paths.js";
import { encodeToonlLines, parseRecords } from "@reddb-io/toon";

type ToonlRow = Record<string, string | number | boolean | null>;

/** The lane's registered retention policy — one declaration, read at append. */
const VERDICT_LANE_POLICY = LANE_RETENTION_REGISTRY["verdicts"];

/** The census id and registry key for this lane. */
export const VERDICT_LANE_ID = "verdicts";

/**
 * What a verifier can conclude. The list is closed: an outcome outside it is a
 * judgement nobody defined, and the land precondition would have to guess.
 *
 * `verifier-blocked` is the fail-closed outcome — the reviewer runner was
 * unavailable or threw — and it parks visibly rather than degrading to a silent
 * skip. `verifier-failed` is a reviewer that ran and refused the change.
 */
export const VERDICT_NAMES = [
  "live-verified",
  "test-verified",
  "type-check-only",
  "verifier-blocked",
  "verifier-failed",
] as const;

export type VerdictName = (typeof VERDICT_NAMES)[number];

/** The `(pr, head_sha, patch_id)` triple every row is keyed by. */
export interface VerdictKey {
  readonly pr: number;
  readonly head_sha: string;
  readonly patch_id: string;
}

/** One appended row. Every field is present so the TOONL segment never rotates. */
export interface VerdictRow extends VerdictKey {
  readonly at: string;
  readonly verdict: VerdictName;
  /** `<runner>:<model>` for an agent verifier, or `human:<login>`. */
  readonly verifier_identity: string;
  /** True when this row supersedes the standing verdict for its key. */
  readonly voided: boolean;
  /** What the verifier cited — a CI run, a gate record. Evidence, never authorization. */
  readonly evidence: string | null;
  /** Why this row was written: the refusal, the block, or the reason for voiding. */
  readonly reason: string | null;
}

export type VerdictAppendInput = VerdictKey & {
  readonly verdict: VerdictName;
  readonly verifier_identity: string;
  readonly at?: string;
  readonly voided?: boolean;
  readonly evidence?: string | null;
  readonly reason?: string | null;
};

/** Voiding names the verdict it supersedes, so the history stays readable. */
export type VerdictVoidInput = VerdictKey & {
  readonly verdict: VerdictName;
  readonly verifier_identity: string;
  readonly reason: string;
  readonly at?: string;
  readonly evidence?: string | null;
};

const VERDICT_FIELDS = [
  "at",
  "pr",
  "head_sha",
  "patch_id",
  "verdict",
  "verifier_identity",
  "voided",
  "evidence",
  "reason",
] as const;

const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/;

export class VerdictLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerdictLedgerError";
  }
}

/** `<runner>:<model>` — the pair that makes an agent verifier distinguishable. */
export function agentVerifierIdentity(runner: string, model: string): string {
  if (runner.trim() === "" || model.trim() === "") {
    throw new VerdictLedgerError("verifier identity needs both a runner and a model");
  }
  return `${runner.trim()}:${model.trim()}`;
}

/** `human:<login>` — a human adopting a branch verifies it under their own name. */
export function humanVerifierIdentity(login: string): string {
  if (login.trim() === "") {
    throw new VerdictLedgerError("human verifier identity needs a login");
  }
  return `human:${login.trim()}`;
}

/** The lane file for one project checkout. PURE. */
export function verdictLedgerPath(projectRoot: string): string {
  return join(castleStateDir(projectRoot), `${VERDICT_LANE_ID}.toonl`);
}

/** One stable string per key, so rows can be grouped without re-comparing fields. PURE. */
export function verdictKeyOf(key: VerdictKey): string {
  return `${key.pr}@${key.head_sha}#${key.patch_id}`;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new VerdictLedgerError(`verdict row needs a non-empty ${field}`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new VerdictLedgerError(`verdict row ${field} must be a string`);
  }
  return value;
}

function requireVerdict(value: unknown): VerdictName {
  if (!VERDICT_NAMES.includes(value as VerdictName)) {
    throw new VerdictLedgerError(
      `unknown verdict ${JSON.stringify(value)}; expected one of ${VERDICT_NAMES.join(", ")}`,
    );
  }
  return value as VerdictName;
}

function requirePr(value: unknown): number {
  const pr = typeof value === "string" ? Number(value) : value;
  if (typeof pr !== "number" || !Number.isSafeInteger(pr) || pr <= 0) {
    throw new VerdictLedgerError("verdict row pr must be a positive integer");
  }
  return pr;
}

function requireHeadSha(value: unknown): string {
  const sha = requireText(value, "head_sha");
  if (!HEAD_SHA_RE.test(sha)) {
    throw new VerdictLedgerError(
      `verdict row head_sha must be a lowercase git object id, got ${JSON.stringify(sha)}`,
    );
  }
  return sha;
}

/**
 * Normalises one decoded or caller-supplied record into a complete row.
 * Validation happens on the way IN and on the way OUT: a lane whose tail was
 * written by an older shape must not silently authorize a merge.
 */
export function normalizeVerdictRow(raw: unknown): VerdictRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VerdictLedgerError("verdict row must be a record");
  }
  const record = raw as Record<string, unknown>;
  const voided = record.voided;
  return {
    at: requireText(record.at, "at"),
    pr: requirePr(record.pr),
    head_sha: requireHeadSha(record.head_sha),
    patch_id: requireText(record.patch_id, "patch_id"),
    verdict: requireVerdict(record.verdict),
    verifier_identity: requireText(record.verifier_identity, "verifier_identity"),
    voided: voided === true || voided === "true",
    evidence: optionalText(record.evidence, "evidence"),
    reason: optionalText(record.reason, "reason"),
  };
}

function toRow(row: VerdictRow): ToonlRow {
  const encoded: ToonlRow = {};
  for (const field of VERDICT_FIELDS) encoded[field] = row[field];
  return encoded;
}

function encodeRows(rows: readonly ToonlRow[]): string {
  if (rows.length === 0) return "";
  const writer = encodeToonlLines({ trailer: false });
  return rows.map((row) => writer.push(row)).join("");
}

function keepLastWithin(
  rows: readonly ToonlRow[],
  incomingBytes: number,
  targetBytes: number,
): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(encodeRows(rows.slice(-middle))) + incomingBytes <= targetBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/**
 * What stands for one key after every row it carries has been read.
 *
 * The rule is positional, not a search for the "best" row: rows are applied in
 * append order, a verdict row sets the standing judgement, and a `voided` row
 * clears it. Nothing is deleted — a voided key still shows every row it ever
 * held, which is exactly what makes the ledger an audit trail rather than a
 * cache of the current answer.
 */
export interface VerdictStanding {
  readonly key: string;
  /** The row that stands, or null when the key's last word was a void. */
  readonly standing: VerdictRow | null;
  /** The void that cleared the standing verdict, when one did. */
  readonly voidedBy: VerdictRow | null;
  /** Every row for the key, oldest first. */
  readonly history: readonly VerdictRow[];
}

/** Fold an append-ordered row stream into one standing per key. PURE. */
export function standingVerdicts(rows: readonly VerdictRow[]): Map<string, VerdictStanding> {
  const byKey = new Map<string, VerdictStanding>();
  for (const row of rows) {
    const key = verdictKeyOf(row);
    const current = byKey.get(key);
    const history = [...(current?.history ?? []), row];
    byKey.set(key, {
      key,
      standing: row.voided ? null : row,
      voidedBy: row.voided ? row : null,
      history,
    });
  }
  return byKey;
}

/** The standing verdict for one key, or null when none stands. PURE. */
export function standingVerdictFor(
  rows: readonly VerdictRow[],
  key: VerdictKey,
): VerdictRow | null {
  return standingVerdicts(rows).get(verdictKeyOf(key))?.standing ?? null;
}

export interface VerdictLedgerFs {
  appendFile(path: string, data: string, encoding: "utf8"): Promise<unknown>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}

export interface VerdictLedgerOptions {
  readonly fs?: VerdictLedgerFs;
  readonly clock?: () => string;
  /** Override the registered byte ceiling; exposed for tiny-lane tests. */
  readonly maxBytes?: number;
}

export interface VerdictLedger {
  readonly path: string;
  /** Appends one row and returns exactly what was written. */
  append(input: VerdictAppendInput): Promise<VerdictRow>;
  /** Appends the `voided` row that supersedes a key's standing verdict. */
  void(input: VerdictVoidInput): Promise<VerdictRow>;
  /** Every row, oldest first. A missing lane reads as no rows, never an error. */
  read(): Promise<VerdictRow[]>;
  /** The standing verdict for one key after the whole lane is folded. */
  standing(key: VerdictKey): Promise<VerdictRow | null>;
}

/**
 * Opens the ledger for one project checkout. Nothing is created until the first
 * append: a checkout that has never landed has no verdicts, and an empty file
 * would claim otherwise.
 */
export function createVerdictLedger(
  projectRoot: string,
  options: VerdictLedgerOptions = {},
): VerdictLedger {
  const fs = options.fs ?? { appendFile, mkdir, readFile };
  const clock = options.clock ?? (() => new Date().toISOString());
  const path = verdictLedgerPath(projectRoot);
  const policy: LaneRetentionPolicy = {
    ...VERDICT_LANE_POLICY,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  };

  const appendRow = async (row: VerdictRow): Promise<VerdictRow> => {
    const encoded = encodeToonlLines().push(toRow(row));
    const incomingBytes = Buffer.byteLength(encoded);
    await fs.mkdir(dirname(path), { recursive: true });
    if (await laneOverCeiling(path, incomingBytes, policy)) {
      const ceiling = policy.maxBytes!;
      if (incomingBytes > ceiling) {
        throw new VerdictLedgerError(`verdict row exceeds its ${ceiling}-byte lane ceiling`);
      }
      const existing = parseRecords(await fs.readFile(path, "utf8")) as ToonlRow[];
      const targetBytes = Math.max(
        incomingBytes,
        Math.floor(ceiling * VERDICT_LANE_POLICY.targetRatio),
      );
      await trimLaneKeepLast(path, keepLastWithin(existing, incomingBytes, targetBytes));
    }
    await fs.appendFile(path, encoded, "utf8");
    return row;
  };

  const readRows = async (): Promise<VerdictRow[]> => {
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseRecords(text).map(normalizeVerdictRow);
  };

  return {
    path,

    // `async` deliberately: a malformed row must REJECT, never throw past an
    // awaiting caller's try/catch on the synchronous side of the call.
    async append(input) {
      return appendRow(normalizeVerdictRow({
        ...input,
        at: input.at ?? clock(),
        voided: input.voided ?? false,
        evidence: input.evidence ?? null,
        reason: input.reason ?? null,
      }));
    },

    async void(input) {
      return appendRow(normalizeVerdictRow({
        ...input,
        at: input.at ?? clock(),
        voided: true,
        evidence: input.evidence ?? null,
        reason: requireText(input.reason, "reason"),
      }));
    },

    read: readRows,

    async standing(key) {
      return standingVerdictFor(await readRows(), key);
    },
  };
}
