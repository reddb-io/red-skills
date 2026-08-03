import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import {
  CASTLE_VALIDATION_SCHEMA_ID,
  createEnginePaths,
  readCastleHistoryRecords,
  readCastleStateSnapshot,
  validateCastleStateSnapshot,
  type CastleValidationRecord,
} from "@reddb-io/red-castle/engine";
import { PHASE_DURATIONS_FILENAME } from "./phase-durations.js";

export type CastleStateFindingKind =
  | "castle-history-invalid"
  | "castle-validation-invalid"
  | "castle-snapshot-invalid"
  | "legacy-afk-residue"
  | "castle-live-artifact";

export type CastleStateVerdict = "warn" | "error";

export interface CastleStateFinding {
  readonly path: string;
  readonly kind: CastleStateFindingKind;
  readonly verdict: CastleStateVerdict;
  readonly reason: string;
  readonly canonicalFix: string;
  readonly fixGate: "delegate";
}

export interface CastleStateDoctorReport {
  readonly status: "pass" | "warn" | "error";
  readonly findings: CastleStateFinding[];
  readonly checked: {
    readonly castleLanePresent: boolean;
    readonly legacyLanePresent: boolean;
  };
}

const CASTLE_FIX = "run the dev durable path migration entrypoint during boot (`red-path-migration`)";

function rel(root: string, path: string): string {
  const out = relative(root, path).replace(/\\/g, "/");
  return out === "" ? "." : out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function nonEmptyDir(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function childDirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function childEntries(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function finding(
  root: string,
  path: string,
  kind: CastleStateFindingKind,
  verdict: CastleStateVerdict,
  reason: string,
  canonicalFix = CASTLE_FIX,
): CastleStateFinding {
  return { path: rel(root, path), kind, verdict, reason, canonicalFix, fixGate: "delegate" };
}

function validateCastleValidationRecord(record: unknown): CastleValidationRecord {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("castle validation record must be an object");
  }
  const raw = { ...(record as Record<string, unknown>) };
  if (raw.schema !== CASTLE_VALIDATION_SCHEMA_ID) {
    throw new Error(`castle validation schema must be ${CASTLE_VALIDATION_SCHEMA_ID}`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new Error("castle validation record needs string name");
  }
  if (raw.status !== "passed" && raw.status !== "failed" && raw.status !== "skipped") {
    throw new Error("castle validation status must be passed, failed, or skipped");
  }
  if (raw.command !== undefined && typeof raw.command !== "string") {
    throw new Error("castle validation command must be string");
  }
  for (const field of ["exitCode", "durationMs"] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== "number") {
      throw new Error(`castle validation ${field} must be number`);
    }
  }
  if (raw.summary !== undefined && typeof raw.summary !== "string") {
    throw new Error("castle validation summary must be string");
  }
  return raw as unknown as CastleValidationRecord;
}

async function auditToonlLanes(root: string, paths: ReturnType<typeof createEnginePaths>): Promise<CastleStateFinding[]> {
  const findings: CastleStateFinding[] = [];
  if (await exists(paths.castleHistory)) {
    try {
      await readCastleHistoryRecords(paths.castleHistory);
    } catch (err) {
      findings.push(
        finding(
          root,
          paths.castleHistory,
          "castle-history-invalid",
          "error",
          `history.toonl is not TOON-decodable as red.castle.history.v1: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  if (await exists(paths.castleValidation)) {
    try {
      parseRecords(await readFile(paths.castleValidation, "utf8")).map(validateCastleValidationRecord);
    } catch (err) {
      findings.push(
        finding(
          root,
          paths.castleValidation,
          "castle-validation-invalid",
          "error",
          `validation.toonl is not TOON-decodable as ${CASTLE_VALIDATION_SCHEMA_ID}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  return findings;
}

async function auditSnapshots(
  root: string,
  paths: ReturnType<typeof createEnginePaths>,
  kind: "worker" | "supervisor",
): Promise<CastleStateFinding[]> {
  const findings: CastleStateFinding[] = [];
  const rootDir = kind === "worker" ? join(paths.castleStateRoot, "workers") : join(paths.castleStateRoot, "supervisors");
  for (const id of await childDirs(rootDir)) {
    const snapshotPath = join(rootDir, id, "state.toon");
    try {
      const snapshot = await readCastleStateSnapshot(snapshotPath);
      if (!snapshot) {
        findings.push(
          finding(
            root,
            snapshotPath,
            "castle-snapshot-invalid",
            "error",
            `${kind} snapshot directory is missing state.toon`,
          ),
        );
        continue;
      }
      validateCastleStateSnapshot(snapshot);
      if (snapshot.kind !== kind || snapshot.id !== id) {
        findings.push(
          finding(
            root,
            snapshotPath,
            "castle-snapshot-invalid",
            "error",
            `${kind} snapshot must carry kind=${kind} and id=${id}`,
          ),
        );
      }
    } catch (err) {
      findings.push(
        finding(
          root,
          snapshotPath,
          "castle-snapshot-invalid",
          "error",
          `${kind} snapshot is not TOON-decodable as red.castle.state.v1: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  }
  return findings;
}

async function auditCastleRootSplit(root: string, paths: ReturnType<typeof createEnginePaths>): Promise<CastleStateFinding[]> {
  // `phase-durations.toonl` is durable state, not a live artifact: it is the
  // measured cost of each pipeline phase (#3097), which is what an ETA is derived
  // from and is worth exactly as much as the history beside it.
  const allowedRootFiles = new Set(["history.toonl", "validation.toonl", PHASE_DURATIONS_FILENAME]);
  const allowedRootDirs = new Set(["workers", "supervisors"]);
  const findings: CastleStateFinding[] = [];
  for (const entry of await childEntries(paths.castleStateRoot)) {
    if (entry.isFile && allowedRootFiles.has(entry.name)) continue;
    if (entry.isDirectory && allowedRootDirs.has(entry.name)) continue;
    findings.push(
      finding(
        root,
        join(paths.castleStateRoot, entry.name),
        "castle-live-artifact",
        "error",
        "live supervisor artifact belongs under .red/tmp/supervisors/default, not the durable castle state lane",
      ),
    );
  }
  return findings;
}

export async function auditCastleStateLane(root: string): Promise<CastleStateDoctorReport> {
  const paths = createEnginePaths(join(root, ".red"));
  const legacyAfkState = join(root, ".red", "state", "afk");
  const castleLanePresent = await nonEmptyDir(paths.castleStateRoot);
  const legacyLanePresent = await nonEmptyDir(legacyAfkState);
  const findings: CastleStateFinding[] = [];

  if (castleLanePresent) {
    findings.push(...await auditCastleRootSplit(root, paths));
    findings.push(...await auditToonlLanes(root, paths));
    findings.push(...await auditSnapshots(root, paths, "worker"));
    findings.push(...await auditSnapshots(root, paths, "supervisor"));
  }

  if (castleLanePresent && legacyLanePresent) {
    findings.push(
      finding(
        root,
        legacyAfkState,
        "legacy-afk-residue",
        "warn",
        "legacy .red/state/afk contains state alongside the live castle state lane",
      ),
    );
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  return {
    status: findings.some((item) => item.verdict === "error") ? "error" : findings.length > 0 ? "warn" : "pass",
    findings,
    checked: { castleLanePresent, legacyLanePresent },
  };
}
