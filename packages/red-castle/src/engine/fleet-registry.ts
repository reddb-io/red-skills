// fleet-registry — the named-fleet profile store (`.red/state/castle/fleets.toonl`).
//
// A named fleet is a FULL profile, not just a label: which runner drains it,
// which slice of the backlog it is scoped to (`selector`), which supervisor
// knobs it overrides (`config`), and which trunk it branches from (`base`).
// The registry is the durable `name -> FleetProfile` map every named
// launch/stop/status path resolves through.
//
// The store is an append-only TOONL lane (ADR 0097 — never JSON): each write
// appends one record and the reader folds them last-write-wins per name, so a
// concurrent writer can never corrupt an earlier profile. A removal appends a
// tombstone rather than rewriting history.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import type { EnginePaths } from "./paths.js";

export class FleetRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetRegistryValidationError";
  }
}

/**
 * The work-scope selector of a named fleet: which candidates it is allowed to
 * drain. Every present facet narrows the pool (they AND together); an empty
 * selector means "the whole backlog".
 */
export interface FleetSelector {
  /** Keep only Tickets linked to this Spec. */
  spec?: number;
  /** Keep only candidates carrying the `lane:<value>` label. */
  lane?: string;
  /** Keep only candidates carrying this exact label. */
  label?: string;
  /** Keep only these issue numbers. */
  issues?: number[];
}

/**
 * Supervisor knobs a fleet profile overrides, as a flat scalar bag. This is the
 * serialisable projection of the consumer's `Partial<SupervisorConfig>` — the
 * registry stays free of the dev-side config type so the substrate can live in
 * the castle while the tunables are still resolved host-side.
 */
export type FleetConfigOverrides = Record<string, string | number | boolean>;

/** One named fleet: runner + work scope + config overrides + base branch. */
export interface FleetProfile {
  name: string;
  runner: string;
  selector?: FleetSelector;
  config?: FleetConfigOverrides;
  /** Branch this fleet's work is cut from. Stored with the profile; the
   * launch-time hookup rides with the castle MCP surface. */
  base?: string;
}

/** The canonical default fleet name — the single supervisor lane that existed
 * before named fleets, and the name every unnamed call resolves to. */
export const DEFAULT_FLEET_NAME = "default";

/** A fleet name must be a safe single path segment: it becomes a directory under
 * `.red/tmp/supervisors/`. `s<pid>` is reserved for the per-process supervisor
 * lane dirs that live alongside the fleet dirs. */
const FLEET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED_FLEET_NAME_RE = /^s[1-9][0-9]*$/;

export function isValidFleetName(name: string): boolean {
  return (
    FLEET_NAME_RE.test(name) &&
    !RESERVED_FLEET_NAME_RE.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

/** Normalise an optional fleet name to the canonical default, validating it. */
export function resolveFleetName(name?: string): string {
  const resolved = name === undefined || name === "" ? DEFAULT_FLEET_NAME : name;
  if (!isValidFleetName(resolved)) {
    throw new FleetRegistryValidationError(
      `invalid fleet name ${JSON.stringify(resolved)}`,
    );
  }
  return resolved;
}

/** The registry file for a repo's `.red` root. */
export function fleetRegistryPath(paths: EnginePaths): string {
  return paths.castleFleets;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FleetRegistryValidationError(`fleet profile needs string ${field}`);
  }
  return value;
}

/**
 * Validate an untrusted value (a decoded CLI flag, an MCP tool argument) as a
 * selector. Unlike the registry's internal normaliser this keeps an empty
 * selector as `{}` — "scoped to everything" is a legitimate answer a caller may
 * have typed, and collapsing it to undefined would hide the flag entirely.
 */
export function parseFleetSelector(value: unknown): FleetSelector {
  return normalizeSelector(value) ?? {};
}

function normalizeSelector(value: unknown): FleetSelector | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FleetRegistryValidationError("fleet selector must be an object");
  }
  const raw = value as Record<string, unknown>;
  const out: FleetSelector = {};
  if (raw.spec !== undefined && raw.spec !== null) {
    if (!Number.isInteger(raw.spec) || (raw.spec as number) <= 0) {
      throw new FleetRegistryValidationError("fleet selector spec must be a positive integer");
    }
    out.spec = raw.spec as number;
  }
  if (raw.lane !== undefined && raw.lane !== null) out.lane = assertNonEmptyString(raw.lane, "selector.lane");
  if (raw.label !== undefined && raw.label !== null) out.label = assertNonEmptyString(raw.label, "selector.label");
  if (raw.issues !== undefined && raw.issues !== null) {
    if (!Array.isArray(raw.issues) || raw.issues.some((n) => !Number.isInteger(n) || (n as number) <= 0)) {
      throw new FleetRegistryValidationError("fleet selector issues must be positive integers");
    }
    out.issues = [...(raw.issues as number[])];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConfig(value: unknown): FleetConfigOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FleetRegistryValidationError("fleet config must be an object");
  }
  const out: FleetConfigOverrides = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      throw new FleetRegistryValidationError(
        `fleet config ${JSON.stringify(key)} must be a string, number, or boolean`,
      );
    }
    out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate + canonicalise one profile. Throws on any malformed field. */
export function validateFleetProfile(profile: FleetProfile): FleetProfile {
  const raw = profile as unknown as Record<string, unknown>;
  const name = resolveFleetName(assertNonEmptyString(raw.name, "name"));
  const runner = assertNonEmptyString(raw.runner, "runner");
  const selector = normalizeSelector(raw.selector);
  const config = normalizeConfig(raw.config);
  const base = raw.base === undefined || raw.base === null ? undefined : assertNonEmptyString(raw.base, "base");
  return {
    name,
    runner,
    ...(selector !== undefined ? { selector } : {}),
    ...(config !== undefined ? { config } : {}),
    ...(base !== undefined ? { base } : {}),
  };
}

function parseNested(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  if (value.length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new FleetRegistryValidationError(`fleet ${field} is not valid JSON`);
  }
}

interface FleetRegistryRow {
  name: string;
  removed: boolean;
  profile?: FleetProfile;
}

function normalizeRow(record: unknown): FleetRegistryRow {
  if (record === null || typeof record !== "object") {
    throw new FleetRegistryValidationError("fleet registry record must be an object");
  }
  const raw = { ...(record as Record<string, unknown>) };
  const name = resolveFleetName(assertNonEmptyString(raw.name, "name"));
  // TOONL scalars: a tombstone round-trips as `true`/`1`/`"true"`.
  const removed = raw.removed === true || raw.removed === 1 || raw.removed === "true";
  if (removed) return { name, removed: true };
  return {
    name,
    removed: false,
    profile: validateFleetProfile({
      name,
      runner: raw.runner as string,
      selector: parseNested(raw.selector, "selector") as FleetSelector | undefined,
      config: parseNested(raw.config, "config") as FleetConfigOverrides | undefined,
      base: raw.base as string | undefined,
    }),
  };
}

function toRow(record: Record<string, unknown>): ToonlRecord {
  const row: ToonlRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    row[key] =
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
        ? value
        : JSON.stringify(value);
  }
  return row;
}

async function append(path: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, encodeLines().push(toRow(record)), "utf8");
}

/**
 * Read every live profile, folded last-write-wins per name with tombstones
 * applied. Insertion order is the order each name FIRST appeared, so a re-edited
 * fleet keeps its listing slot. A missing registry reads as an empty list.
 */
export async function readFleetProfiles(path: string): Promise<FleetProfile[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const byName = new Map<string, FleetProfile | null>();
  for (const record of parseRecords(text)) {
    const row = normalizeRow(record);
    byName.set(row.name, row.removed ? null : row.profile!);
  }
  return [...byName.values()].filter((p): p is FleetProfile => p !== null);
}

/** Read one named profile, or undefined when it was never written / was removed. */
export async function readFleetProfile(
  path: string,
  name: string,
): Promise<FleetProfile | undefined> {
  const wanted = resolveFleetName(name);
  return (await readFleetProfiles(path)).find((p) => p.name === wanted);
}

/** Create or replace a named profile. Returns the canonicalised profile written. */
export async function upsertFleetProfile(
  path: string,
  profile: FleetProfile,
): Promise<FleetProfile> {
  const validated = validateFleetProfile(profile);
  await append(path, { ...validated, removed: false });
  return validated;
}

/** Tombstone a named profile. Returns false when no live profile carried the name. */
export async function removeFleetProfile(path: string, name: string): Promise<boolean> {
  const wanted = resolveFleetName(name);
  const existing = await readFleetProfile(path, wanted);
  if (!existing) return false;
  await append(path, { name: wanted, removed: true });
  return true;
}
