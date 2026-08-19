// work-selector — which slice of the backlog a producer is allowed to drain.
//
// This is what survived the Fleet's extinction (ADR 0130). The named-fleet
// registry that once stored a `name -> profile` map is gone, because a project
// has exactly one demand producer and nothing left to name; the **work scope**
// it applied was never about the resource unit, so it stays — as work policy
// held by the project's producer rather than by a registered fleet.
//
// Pure validation over untrusted values (a decoded CLI flag, an MCP tool
// argument). Nothing here reads or writes the filesystem.

export class WorkSelectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkSelectorValidationError";
  }
}

/**
 * A producer's work scope: which candidates it is allowed to drain. Every
 * present facet narrows the pool (they AND together); an empty selector means
 * "the whole backlog".
 */
export interface WorkSelector {
  /** Keep only Tickets linked to this Spec. */
  spec?: number;
  /** Keep only candidates carrying the `lane:<value>` label. */
  lane?: string;
  /** Keep only candidates carrying this exact label. */
  label?: string;
  /** Keep only these issue numbers. */
  issues?: number[];
  /** Keep only candidates carrying EVERY `tag:<value>` label listed here
   * (values are bare, without the `tag:` prefix). Candidates missing any of
   * them — including fully untagged candidates — are excluded. */
  tags?: string[];
  /** Keep only candidates authored by this GitHub login. `@me` is accepted as
   * a value here; the consumer resolves it to a concrete login before the
   * selector is matched. */
  user?: string;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkSelectorValidationError(`work selector needs string ${field}`);
  }
  return value;
}

/**
 * Validate an untrusted value as a selector. An empty selector stays `{}` —
 * "scoped to everything" is a legitimate answer a caller may have typed, and
 * collapsing it to undefined would hide the flag entirely.
 */
export function parseWorkSelector(value: unknown): WorkSelector {
  return normalizeWorkSelector(value) ?? {};
}

/** Validate an optional selector, collapsing a fully empty one to undefined. */
export function normalizeWorkSelector(value: unknown): WorkSelector | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkSelectorValidationError("work selector must be an object");
  }
  const raw = value as Record<string, unknown>;
  const out: WorkSelector = {};
  if (raw.spec !== undefined && raw.spec !== null) {
    if (!Number.isInteger(raw.spec) || (raw.spec as number) <= 0) {
      throw new WorkSelectorValidationError("work selector spec must be a positive integer");
    }
    out.spec = raw.spec as number;
  }
  if (raw.lane !== undefined && raw.lane !== null) out.lane = assertNonEmptyString(raw.lane, "selector.lane");
  if (raw.label !== undefined && raw.label !== null) out.label = assertNonEmptyString(raw.label, "selector.label");
  if (raw.issues !== undefined && raw.issues !== null) {
    if (!Array.isArray(raw.issues) || raw.issues.some((n) => !Number.isInteger(n) || (n as number) <= 0)) {
      throw new WorkSelectorValidationError("work selector issues must be positive integers");
    }
    out.issues = [...(raw.issues as number[])];
  }
  if (raw.tags !== undefined && raw.tags !== null) {
    out.tags = normalizeSelectorTags(raw.tags);
  }
  if (raw.user !== undefined && raw.user !== null) {
    out.user = assertNonEmptyString(raw.user, "selector.user");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Bare tag values only: the `tag:` prefix is composed at match time, so a
 * value containing `:` (e.g. an accidental `tag:backend`) is rejected rather
 * than silently matched as `tag:tag:backend`. */
const SELECTOR_TAG_VALUE_RE = /^[a-z0-9][a-z0-9-]*$/;

function normalizeSelectorTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkSelectorValidationError(
      "work selector tags must be a non-empty array of bare tag values",
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    const tag = typeof entry === "string" ? entry.trim() : "";
    if (!SELECTOR_TAG_VALUE_RE.test(tag)) {
      throw new WorkSelectorValidationError(
        `work selector tags must match ${SELECTOR_TAG_VALUE_RE} (bare value, no "tag:" prefix): ${JSON.stringify(entry)}`,
      );
    }
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Config overrides a producer carries alongside its selector, as a flat scalar
 * bag. This is the serialisable projection of the consumer's supervisor config
 * — the engine stays free of the dev-side config type. */
export type WorkConfigOverrides = Record<string, string | number | boolean>;

/** Validate an untrusted config-override bag. */
export function normalizeWorkConfig(value: unknown): WorkConfigOverrides | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkSelectorValidationError("work config must be an object");
  }
  const out: WorkConfigOverrides = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (val === undefined || val === null) continue;
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") {
      throw new WorkSelectorValidationError(
        `work config ${JSON.stringify(key)} must be a string, number, or boolean`,
      );
    }
    out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
