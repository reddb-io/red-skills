/** Durable, resumable cross-major authority handover for redskilled. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";

export type RedskilledMajorHandoverPhase = "quiesced" | "released" | "migrated" | "active";

export interface RedskilledMajorHandoverWorker {
  readonly worker_id: string;
  readonly outcome: "drained" | "terminally-accounted";
}

/**
 * Migration metadata only. Project workflow state remains in its durable stores
 * and is never copied through a cross-major process or checkpoint payload.
 */
export interface RedskilledMajorHandoverCheckpoint {
  readonly version: 1;
  readonly handover_id: string;
  readonly from_major: number;
  readonly to_major: number;
  readonly phase: RedskilledMajorHandoverPhase;
  readonly workers: readonly RedskilledMajorHandoverWorker[];
  readonly checkpointed_at: string;
  readonly released_at?: string;
  readonly migrated_at?: string;
  readonly activated_at?: string;
}

export interface QuiesceRedskilledMajorInput {
  readonly fromMajor: number;
  readonly toMajor: number;
  /** Close every route that could admit new work before observing Workers. */
  stopAdmission(): Promise<void>;
  /** Finish live Workers or durably record one terminal outcome for each. */
  drainWorkers(): Promise<readonly RedskilledMajorHandoverWorker[]>;
  /** Settle the old major's serialized GitHub outbox before budget release. */
  flushGithubWrites(): Promise<void>;
  /** Release Projects, the GitHub budget, and the one public endpoint together. */
  releaseAuthority(): Promise<void>;
}

export interface ActivateRedskilledMajorInput {
  readonly toMajor: number;
  /** Idempotently migrate durable stores while neither major is authoritative. */
  migrate(checkpoint: RedskilledMajorHandoverCheckpoint): Promise<void>;
  /** Bind the endpoint and begin admission only after migration completes. */
  assumeAuthority(): Promise<void>;
}

export interface RedskilledMajorHandover {
  read(): Promise<RedskilledMajorHandoverCheckpoint | null>;
  quiesce(input: QuiesceRedskilledMajorInput): Promise<RedskilledMajorHandoverCheckpoint>;
  activate(input: ActivateRedskilledMajorInput): Promise<RedskilledMajorHandoverCheckpoint>;
}

export interface CreateRedskilledMajorHandoverOptions {
  readonly clock?: () => string;
  readonly id?: () => string;
}

/**
 * Create the one checkpoint lane shared by the outgoing and incoming majors.
 *
 * The old major checkpoints only after admission, Workers, and pending writes
 * are quiescent. It retains all authority until that checkpoint is durable. The
 * new major may migrate only from `released`, and may assume authority only from
 * `migrated`. Re-entering either method resumes at the last durable phase.
 */
export function createRedskilledMajorHandover(
  path: string,
  options: CreateRedskilledMajorHandoverOptions = {},
): RedskilledMajorHandover {
  const clock = options.clock ?? (() => new Date().toISOString());
  const id = options.id ?? randomUUID;
  let tail: Promise<unknown> = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  const read = async (): Promise<RedskilledMajorHandoverCheckpoint | null> => {
    try {
      return parseCheckpoint(decode((await readFile(path, "utf8")).trim()));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const persist = async (
    checkpoint: RedskilledMajorHandoverCheckpoint,
  ): Promise<RedskilledMajorHandoverCheckpoint> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${encode(checkpoint as unknown as JsonValue)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    return checkpoint;
  };

  return {
    read,
    quiesce(input) {
      return serialized(async () => {
        requireMajorPair(input.fromMajor, input.toMajor);
        let checkpoint = await read();
        if (checkpoint?.phase === "active" && checkpoint.to_major === input.fromMajor) checkpoint = null;
        if (checkpoint != null) requireSameHandover(checkpoint, input.fromMajor, input.toMajor);
        if (checkpoint?.phase === "released" || checkpoint?.phase === "migrated" || checkpoint?.phase === "active") {
          return checkpoint;
        }

        await input.stopAdmission();
        if (checkpoint == null) {
          const workers = validateWorkers(await input.drainWorkers());
          await input.flushGithubWrites();
          checkpoint = await persist({
            version: 1,
            handover_id: nonEmpty(id(), "a major handover needs an id"),
            from_major: input.fromMajor,
            to_major: input.toMajor,
            phase: "quiesced",
            workers,
            checkpointed_at: timestamp(clock()),
          });
        }

        await input.releaseAuthority();
        return await persist({
          ...checkpoint,
          phase: "released",
          released_at: timestamp(clock()),
        });
      });
    },
    activate(input) {
      return serialized(async () => {
        requireMajor(input.toMajor, "target");
        let checkpoint = await read();
        if (checkpoint == null) throw new Error("redskilled major handover has no durable checkpoint");
        if (checkpoint.to_major !== input.toMajor) {
          throw new Error(
            `redskilled major handover targets wire major ${checkpoint.to_major}, not ${input.toMajor}`,
          );
        }
        if (checkpoint.phase === "quiesced") {
          throw new Error("redskilled major handover cannot migrate before the old major releases authority");
        }
        if (checkpoint.phase === "active") return checkpoint;

        if (checkpoint.phase === "released") {
          await input.migrate(checkpoint);
          checkpoint = await persist({
            ...checkpoint,
            phase: "migrated",
            migrated_at: timestamp(clock()),
          });
        }

        await input.assumeAuthority();
        return await persist({
          ...checkpoint,
          phase: "active",
          activated_at: timestamp(clock()),
        });
      });
    },
  };
}

function requireMajorPair(fromMajor: number, toMajor: number): void {
  requireMajor(fromMajor, "source");
  requireMajor(toMajor, "target");
  if (fromMajor === toMajor) throw new Error("a major handover must cross RedSkills wire majors");
}

function requireMajor(major: number, label: string): void {
  if (!Number.isSafeInteger(major) || major <= 0) {
    throw new Error(`a major handover needs one positive ${label} wire major`);
  }
}

function requireSameHandover(
  checkpoint: RedskilledMajorHandoverCheckpoint,
  fromMajor: number,
  toMajor: number,
): void {
  if (checkpoint.from_major !== fromMajor || checkpoint.to_major !== toMajor) {
    throw new Error(
      `unfinished redskilled major handover ${checkpoint.from_major}->${checkpoint.to_major} ` +
        `cannot be replaced by ${fromMajor}->${toMajor}`,
    );
  }
}

function validateWorkers(
  workers: readonly RedskilledMajorHandoverWorker[],
): readonly RedskilledMajorHandoverWorker[] {
  const seen = new Set<string>();
  return workers.map((worker) => {
    const workerId = nonEmpty(worker.worker_id, "a major handover Worker needs an id");
    if (seen.has(workerId)) throw new Error(`major handover accounts for Worker ${JSON.stringify(workerId)} twice`);
    seen.add(workerId);
    if (worker.outcome !== "drained" && worker.outcome !== "terminally-accounted") {
      throw new Error(`major handover Worker ${JSON.stringify(workerId)} has no terminal outcome`);
    }
    return { worker_id: workerId, outcome: worker.outcome };
  });
}

function parseCheckpoint(value: unknown): RedskilledMajorHandoverCheckpoint {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("redskilled major handover checkpoint is not a snapshot");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "handover_id",
    "from_major",
    "to_major",
    "phase",
    "workers",
    "checkpointed_at",
    "released_at",
    "migrated_at",
    "activated_at",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("redskilled major handover checkpoint contains workflow state or an unknown field");
  }
  if (record.version !== 1) throw new Error("redskilled major handover checkpoint has an unsupported version");
  requireMajorPair(record.from_major as number, record.to_major as number);
  if (!isPhase(record.phase)) throw new Error("redskilled major handover checkpoint has an invalid phase");
  if (!Array.isArray(record.workers)) throw new Error("redskilled major handover checkpoint has no Worker accounting");

  const checkpoint: RedskilledMajorHandoverCheckpoint = {
    version: 1,
    handover_id: nonEmpty(record.handover_id, "redskilled major handover checkpoint has no id"),
    from_major: record.from_major as number,
    to_major: record.to_major as number,
    phase: record.phase,
    workers: validateWorkers(record.workers as RedskilledMajorHandoverWorker[]),
    checkpointed_at: timestamp(record.checkpointed_at),
    ...(record.released_at == null ? {} : { released_at: timestamp(record.released_at) }),
    ...(record.migrated_at == null ? {} : { migrated_at: timestamp(record.migrated_at) }),
    ...(record.activated_at == null ? {} : { activated_at: timestamp(record.activated_at) }),
  };
  requirePhaseTimestamps(checkpoint);
  return checkpoint;
}

function isPhase(value: unknown): value is RedskilledMajorHandoverPhase {
  return value === "quiesced" || value === "released" || value === "migrated" || value === "active";
}

function requirePhaseTimestamps(checkpoint: RedskilledMajorHandoverCheckpoint): void {
  if (checkpoint.phase !== "quiesced" && checkpoint.released_at == null) {
    throw new Error("released major handover checkpoint has no release timestamp");
  }
  if ((checkpoint.phase === "migrated" || checkpoint.phase === "active") && checkpoint.migrated_at == null) {
    throw new Error("migrated major handover checkpoint has no migration timestamp");
  }
  if (checkpoint.phase === "active" && checkpoint.activated_at == null) {
    throw new Error("active major handover checkpoint has no activation timestamp");
  }
}

function nonEmpty(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(message);
  return value.trim();
}

function timestamp(value: unknown): string {
  const timestamp = nonEmpty(value, "a major handover checkpoint needs a timestamp");
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error("a major handover checkpoint timestamp is invalid");
  return timestamp;
}
