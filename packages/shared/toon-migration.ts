import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, type JsonValue } from "@reddb-io/toon";
import { serialize as encode } from "@reddb-io/toon/legacy";
import { rspStateDir } from "./red-paths.js";

/**
 * Encodes an rsp snapshot surface as TOON with keyed-map collapse enabled
 * (toon 0.3 line — the lossless tabular form for uniform object maps). Collapse
 * is opportunistic: the encoder only rewrites a keyed map whose values are two
 * or more uniform objects, so flat objects and array-wrapped surfaces come out
 * byte-identical to `encode(value)`. Every reader is `decode`, which parses the
 * collapsed and non-collapsed forms transparently, so enabling the flag never
 * breaks a consumer. Use this at every rsp snapshot TOON emit point so a
 * qualifying shape wins the extra tokens the moment it appears (Spec #1801).
 */
export function encodeSnapshotToon(value: JsonValue): string {
  return encode(value, { keyedMapCollapse: true });
}

export type RegisteredToonSurfaceKind = "toon" | "toonl";
export type RegisteredToonSurfacePlugin = "memory" | "brain" | "dev";

export interface RegisteredToonSurface {
  id: string;
  plugin: RegisteredToonSurfacePlugin;
  legacyPath: string;
  toonPath: string;
  kind: RegisteredToonSurfaceKind;
  migration?: "convert" | "sniff-read";
}

export interface ToonMigrationReport {
  status: "converted" | "noop" | "refused";
  converted: string[];
  skipped: string[];
  missing: string[];
  reasons: string[];
}

export interface ToonSurfaceReadResult {
  surface: RegisteredToonSurface;
  path: string;
  format: "json" | "jsonl" | "toon" | "toonl";
  value: unknown;
}

export interface ConvertRegisteredToonSurfacesOptions {
  rootDir: string;
  plugin?: RegisteredToonSurfacePlugin;
  surfaces?: readonly RegisteredToonSurface[];
}

export const MEMORY_TOON_MIGRATION_SURFACES: readonly RegisteredToonSurface[] = [
  {
    id: "memory.config",
    plugin: "memory",
    legacyPath: ".red/memory/config.json",
    toonPath: ".red/memory/config.toon",
    kind: "toon",
  },
];

export const DEV_TOON_MIGRATION_SURFACES: readonly RegisteredToonSurface[] = [
  {
    id: "dev.afk-history",
    plugin: "dev",
    legacyPath: ".red/state/afk-history.jsonl",
    toonPath: ".red/state/castle/history.toonl",
    kind: "toonl",
  },
  {
    id: "dev.agent-log",
    plugin: "dev",
    legacyPath: ".red/tmp/agent.log.toonl",
    toonPath: ".red/tmp/agent.log.toonl",
    kind: "toonl",
  },
  {
    id: "dev.supervisor-firehose",
    plugin: "dev",
    legacyPath: ".red/tmp/afk-supervisor.log.toonl",
    toonPath: ".red/tmp/supervisors/default/supervisor.log.toonl",
    kind: "toonl",
    migration: "sniff-read",
  },
  {
    id: "dev.code-understanding-bench-runs",
    plugin: "dev",
    legacyPath: ".red/tmp/bench/code-understanding/runs.jsonl",
    toonPath: ".red/tmp/bench/code-understanding/runs.toonl",
    kind: "toonl",
  },
  {
    id: "dev.attempt-state",
    plugin: "dev",
    legacyPath: ".red/tmp/{workers,go-workers,scout-workers}/*/*/afk.state.toon",
    toonPath: ".red/tmp/{workers,go-workers,scout-workers}/*/*/afk.state.toon",
    kind: "toon",
  },
  {
    id: "dev.statusline-count-cache",
    plugin: "dev",
    legacyPath: ".red/tmp/statusline-cache.json",
    toonPath: ".red/state/statusline/statusline-cache.toon",
    kind: "toon",
  },
  {
    id: "dev.statusline-repo-cache",
    plugin: "dev",
    legacyPath: ".red/tmp/statusline-repo-cache.json",
    toonPath: ".red/state/statusline/statusline-repo-cache.toon",
    kind: "toon",
  },
  {
    id: "dev.rsp-resident-registry",
    plugin: "dev",
    legacyPath: ".red/state/rsp/rsp-resident.pid.json",
    toonPath: ".red/state/rsp/rsp-resident.pid.json",
    kind: "toon",
  },
  {
    id: "dev.rsp-status-summary",
    plugin: "dev",
    legacyPath: ".red/state/rsp/rsp-status-summary.json",
    toonPath: ".red/state/rsp/rsp-status-summary.json",
    kind: "toon",
  },
  {
    id: "dev.rsp-wait-registry",
    plugin: "dev",
    legacyPath: ".red/tmp/waits/*.json",
    toonPath: ".red/tmp/waits/*.json",
    kind: "toon",
  },
];

export const REGISTERED_TOON_MIGRATION_SURFACES: readonly RegisteredToonSurface[] = [
  ...MEMORY_TOON_MIGRATION_SURFACES,
  ...DEV_TOON_MIGRATION_SURFACES,
];

export function registeredToonSurfacesForPlugin(
  plugin: RegisteredToonSurfacePlugin,
  surfaces: readonly RegisteredToonSurface[] = REGISTERED_TOON_MIGRATION_SURFACES,
): readonly RegisteredToonSurface[] {
  return surfaces.filter((surface) => surface.plugin === plugin);
}

export function hasPendingRegisteredToonSurfaces(
  rootDir: string,
  plugin: RegisteredToonSurfacePlugin,
  surfaces: readonly RegisteredToonSurface[] = REGISTERED_TOON_MIGRATION_SURFACES,
): boolean {
  return registeredToonSurfacesForPlugin(plugin, surfaces).some((surface) => {
    const legacy = join(rootDir, surface.legacyPath);
    const converted = join(rootDir, surface.toonPath);
    return pathExistsSync(legacy) && !pathExistsSync(converted);
  });
}

export async function convertRegisteredToonSurfaces(
  opts: ConvertRegisteredToonSurfacesOptions,
): Promise<ToonMigrationReport> {
  const surfaces = opts.surfaces ?? REGISTERED_TOON_MIGRATION_SURFACES;
  const selected = opts.plugin === undefined ? surfaces : registeredToonSurfacesForPlugin(opts.plugin, surfaces);
  const reasons = await quiescenceReasons(opts.rootDir);
  if (reasons.length > 0) {
    return { status: "refused", converted: [], skipped: [], missing: [], reasons };
  }

  const converted: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];

  for (const surface of selected) {
    if (surface.migration === "sniff-read") {
      if ((await pathExists(join(opts.rootDir, surface.toonPath))) || (await pathExists(join(opts.rootDir, surface.legacyPath)))) skipped.push(surface.id);
      else missing.push(surface.id);
      continue;
    }

    const targets = await expandSurfaceTargets(opts.rootDir, surface);
    if (targets.length === 0) {
      missing.push(surface.id);
      continue;
    }

    let convertedAny = false;
    let skippedAny = false;
    for (const targetInfo of targets) {
      const target = targetInfo.toonPath;
      if (await targetAlreadyConverted(targetInfo)) {
        skippedAny = true;
        continue;
      }

      const legacy = targetInfo.legacyPath;
      if (!(await pathExists(legacy))) {
        continue;
      }

      const value = await readLegacyFile(legacy, surface.kind);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, renderSurface(value, surface), "utf8");
      if (surface.id === "dev.afk-history" && legacy !== target) {
        await rm(legacy, { force: true });
      }
      convertedAny = true;
    }

    if (convertedAny) {
      converted.push(surface.id);
    } else if (skippedAny) {
      skipped.push(surface.id);
    } else {
      missing.push(surface.id);
    }
  }

  return {
    status: converted.length > 0 ? "converted" : "noop",
    converted,
    skipped,
    missing,
    reasons: [],
  };
}

export async function readRegisteredToonSurface(
  rootDir: string,
  surfaceId: string,
  surfaces: readonly RegisteredToonSurface[] = REGISTERED_TOON_MIGRATION_SURFACES,
): Promise<ToonSurfaceReadResult> {
  const surface = surfaces.find((candidate) => candidate.id === surfaceId);
  if (!surface) throw new Error(`unknown registered TOON surface: ${surfaceId}`);

  if (surface.migration === "sniff-read") {
    const toonPath = join(rootDir, surface.toonPath);
    const path = (await pathExists(toonPath)) ? toonPath : join(rootDir, surface.legacyPath);
    return {
      surface,
      path,
      format: surface.kind,
      value: surface.kind === "toonl" ? await readSniffedToonlFile(path) : await readSnapshotDocument(await readFile(path, "utf8")),
    };
  }

  const converted = join(rootDir, surface.toonPath);
  if (await pathExists(converted) && await isReadableConvertedFile(converted, surface.kind)) {
    return {
      surface,
      path: converted,
      format: surface.kind,
      value: await readConvertedFile(converted, surface.kind),
    };
  }

  const legacy = join(rootDir, surface.legacyPath);
  return {
    surface,
    path: legacy,
    format: surface.kind === "toonl" ? "jsonl" : "json",
    value: await readLegacyFile(legacy, surface.kind),
  };
}

interface SurfaceTarget {
  surface: RegisteredToonSurface;
  legacyPath: string;
  toonPath: string;
}

async function expandSurfaceTargets(rootDir: string, surface: RegisteredToonSurface): Promise<SurfaceTarget[]> {
  if (surface.id === "dev.rsp-wait-registry") {
    const waitsRoot = join(rootDir, ".red", "tmp", "waits");
    let entries: string[];
    try {
      entries = await readdir(waitsRoot);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => {
        const path = join(waitsRoot, entry);
        return { surface, legacyPath: path, toonPath: path };
      });
  }
  if (surface.id !== "dev.attempt-state") {
    return [{ surface, legacyPath: join(rootDir, surface.legacyPath), toonPath: join(rootDir, surface.toonPath) }];
  }
  const out: SurfaceTarget[] = [];
  for (const namespace of ["workers", "go-workers", "scout-workers"]) {
    const nsRoot = join(rootDir, ".red", "tmp", namespace);
    let workers: string[];
    try {
      workers = await readdir(nsRoot);
    } catch {
      continue;
    }
    for (const worker of workers) {
      const workerRoot = join(nsRoot, worker);
      let attempts: string[];
      try {
        attempts = await readdir(workerRoot);
      } catch {
        continue;
      }
      for (const attempt of attempts) {
        const path = join(workerRoot, attempt, "afk.state.toon");
        if (await pathExists(path)) out.push({ surface, legacyPath: path, toonPath: path });
      }
    }
  }
  return out;
}

async function targetAlreadyConverted(target: SurfaceTarget): Promise<boolean> {
  if (!(await pathExists(target.toonPath))) return false;
  if (target.legacyPath !== target.toonPath) return true;
  return isReadableConvertedFile(target.toonPath, target.surface.kind);
}

async function isReadableConvertedFile(path: string, kind: RegisteredToonSurfaceKind): Promise<boolean> {
  try {
    await readConvertedFile(path, kind);
    return true;
  } catch {
    return false;
  }
}

async function quiescenceReasons(rootDir: string): Promise<string[]> {
  const reasons: string[] = [];
  const tmpDir = join(rootDir, ".red", "tmp");
  const supervisorPid = await readPidFile(join(tmpDir, "afk-supervisor.pid"));
  if (supervisorPid !== null && isLivePid(supervisorPid)) {
    reasons.push("active fleet supervisor is running");
  }

  const rspResidentPid = await readJsonPid(join(rspStateDir(rootDir), "rsp-resident.pid.json"));
  if (rspResidentPid !== null && isLivePid(rspResidentPid)) {
    reasons.push("active rsp resident is running");
  }

  return reasons;
}

async function readLegacyFile(path: string, kind: RegisteredToonSurfaceKind): Promise<unknown> {
  const body = await readFile(path, "utf8");
  if (kind === "toonl") {
    const rows: unknown[] = [];
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Append-only lanes may end with a torn crash-tail row; convert the
        // parseable prefix and let the next segment start clean.
      }
    }
    return rows;
  }
  return JSON.parse(body);
}

async function readSniffedToonlFile(path: string): Promise<unknown[]> {
  const body = await readFile(path, "utf8");
  const rows: unknown[] = [];
  let header = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("{")) {
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        // Append-only lanes may end with a torn crash-tail row.
      }
      continue;
    }
    if (/^\[(?:[0-9]+)?\](?:\{[^}]+\}:|:)$/.test(trimmed)) {
      header = trimmed;
      continue;
    }
    if (!header) continue;
    try {
      const normalizedHeader = header.replace(/^\[(?:[0-9]+)?\]/, "[1]");
      const value = decode(`${normalizedHeader}\n${line}\n`);
      rows.push(Array.isArray(value) ? value[0] : value);
    } catch {
      // TOONL readers are crash-tail tolerant during rollout.
    }
  }
  return rows;
}

async function readConvertedFile(path: string, kind: RegisteredToonSurfaceKind): Promise<unknown> {
  const body = await readFile(path, "utf8");
  return decode(body);
}

function renderSurface(value: unknown, surface: RegisteredToonSurface): string {
  if (surface.kind === "toonl") {
    const rows = normalizeToonlRows(surface, Array.isArray(value) ? value : [value]);
    return encode(rows as JsonValue);
  }
  return encodeSnapshotToon(value as JsonValue);
}

function normalizeToonlRows(surface: RegisteredToonSurface, rows: unknown[]): unknown[] {
  if (surface.id === "dev.agent-log") {
    return rows.map((row) => {
      const rec = row && typeof row === "object" ? row as Record<string, unknown> : {};
      return {
        ts: typeof rec.ts === "string" ? rec.ts : "",
        lvl: typeof rec.lvl === "string" && rec.lvl.length > 0 ? rec.lvl : null,
        worker: typeof rec.worker === "string" && rec.worker.length > 0 ? rec.worker : null,
        issue: Number.isFinite(Number(rec.issue)) ? Number(rec.issue) : null,
        attempt: Number.isFinite(Number(rec.attempt)) ? Number(rec.attempt) : null,
        type: typeof rec.type === "string" ? rec.type : "",
        msg: rec.msg === undefined ? "" : rec.msg,
        iteration: rec.iteration === undefined ? null : rec.iteration,
        kind: rec.kind === undefined ? null : rec.kind,
      };
    });
  }
  if (surface.id !== "dev.afk-history") return rows;
  return rows.map((row) => {
    const rec = row && typeof row === "object" ? row as Record<string, unknown> : {};
    return {
      ts: typeof rec.ts === "string" ? rec.ts : "",
      epoch: Number.isFinite(Number(rec.epoch)) ? Number(rec.epoch) : 0,
      worker: typeof rec.worker === "string" ? rec.worker : "",
      issue: Number.isFinite(Number(rec.issue)) ? Number(rec.issue) : 0,
      event: typeof rec.event === "string" ? rec.event : "",
      duration_s: Number.isFinite(Number(rec.duration_s)) ? Number(rec.duration_s) : 0,
      runner: typeof rec.runner === "string" ? rec.runner : "",
      merge_sha: typeof rec.merge_sha === "string" && rec.merge_sha.length > 0 ? rec.merge_sha : null,
      reason: typeof rec.reason === "string" && rec.reason.length > 0 ? rec.reason : null,
    };
  });
}

async function readPidFile(path: string): Promise<number | null> {
  try {
    return parsePid((await readFile(path, "utf8")).trim());
  } catch {
    return null;
  }
}

async function readJsonPid(path: string): Promise<number | null> {
  try {
    const parsed = readSnapshotDocument(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsePid(String(parsed.pid)) : null;
  } catch {
    return null;
  }
}

function readSnapshotDocument(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return decode(body);
  }
}

function parsePid(raw: string): number | null {
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) ? pid : null;
}

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
