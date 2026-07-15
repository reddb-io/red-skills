import { accessSync, constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";

export type RegisteredToonSurfaceKind = "toon" | "toonl";
export type RegisteredToonSurfacePlugin = "memory" | "brain" | "dev";

export interface RegisteredToonSurface {
  id: string;
  plugin: RegisteredToonSurfacePlugin;
  legacyPath: string;
  toonPath: string;
  kind: RegisteredToonSurfaceKind;
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

export const REGISTERED_TOON_MIGRATION_SURFACES: readonly RegisteredToonSurface[] = [
  ...MEMORY_TOON_MIGRATION_SURFACES,
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
    const target = join(opts.rootDir, surface.toonPath);
    if (await pathExists(target)) {
      skipped.push(surface.id);
      continue;
    }

    const legacy = join(opts.rootDir, surface.legacyPath);
    if (!(await pathExists(legacy))) {
      missing.push(surface.id);
      continue;
    }

    const value = await readLegacyFile(legacy, surface.kind);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, renderSurface(value, surface.kind), "utf8");
    converted.push(surface.id);
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

  const converted = join(rootDir, surface.toonPath);
  if (await pathExists(converted)) {
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

async function quiescenceReasons(rootDir: string): Promise<string[]> {
  const reasons: string[] = [];
  const tmpDir = join(rootDir, ".red", "tmp");
  const supervisorPid = await readPidFile(join(tmpDir, "afk-supervisor.pid"));
  if (supervisorPid !== null && isLivePid(supervisorPid)) {
    reasons.push("active fleet supervisor is running");
  }

  const rspResidentPid = await readJsonPid(join(tmpDir, "rsp-resident.pid.json"));
  if (rspResidentPid !== null && isLivePid(rspResidentPid)) {
    reasons.push("active rsp resident is running");
  }

  return reasons;
}

async function readLegacyFile(path: string, kind: RegisteredToonSurfaceKind): Promise<unknown> {
  const body = await readFile(path, "utf8");
  if (kind === "toonl") {
    return body
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }
  return JSON.parse(body);
}

async function readConvertedFile(path: string, kind: RegisteredToonSurfaceKind): Promise<unknown> {
  const body = await readFile(path, "utf8");
  if (kind === "toonl") {
    return body
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => decode(line));
  }
  return decode(body);
}

function renderSurface(value: unknown, kind: RegisteredToonSurfaceKind): string {
  if (kind === "toonl") {
    const rows = Array.isArray(value) ? value : [value];
    return `${rows.map((row) => encode(row as JsonValue)).join("\n")}\n`;
  }
  return encode(value as JsonValue);
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
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsePid(String(parsed.pid)) : null;
  } catch {
    return null;
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
