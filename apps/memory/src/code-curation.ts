import {
  EXTRACTION_SCHEMA_VERSION,
  SUGGESTED_ENGINEERING_CODES,
  normalizeEngineeringCode,
} from "./extraction-schema.js";
import type { MemoryStore } from "./graph-store.js";

export const ENGINEERING_CODE_CURATION_KEY = "engineering-code:curation:v1";

export interface EngineeringCodeAlias {
  from: string;
  to: string;
}

export interface EngineeringCodeCurationState {
  schemaVersion: string;
  suggestedVersion: string;
  promoted: string[];
  aliases: EngineeringCodeAlias[];
}

export interface EngineeringCodeCurationResult {
  state: EngineeringCodeCurationState;
  changed: boolean;
}

export const EMPTY_ENGINEERING_CODE_CURATION: EngineeringCodeCurationState = Object.freeze({
  schemaVersion: EXTRACTION_SCHEMA_VERSION,
  suggestedVersion: "1.1.0",
  promoted: [],
  aliases: [],
});

export function suggestedEngineeringCodes(
  state: EngineeringCodeCurationState = EMPTY_ENGINEERING_CODE_CURATION,
): string[] {
  return sortedUnique([...SUGGESTED_ENGINEERING_CODES, ...state.promoted]);
}

export function promotedEngineeringCodeSet(
  state: EngineeringCodeCurationState = EMPTY_ENGINEERING_CODE_CURATION,
): ReadonlySet<string> {
  return new Set(suggestedEngineeringCodes(state));
}

export function isCuratedSuggestedEngineeringCode(
  code: string,
  state: EngineeringCodeCurationState = EMPTY_ENGINEERING_CODE_CURATION,
): boolean {
  return promotedEngineeringCodeSet(state).has(resolveEngineeringCodeAlias(code, state));
}

export function resolveEngineeringCodeAlias(
  code: string,
  state: EngineeringCodeCurationState = EMPTY_ENGINEERING_CODE_CURATION,
): string {
  let current = normalizeEngineeringCode(code);
  if (!current) return "";
  const aliases = new Map(state.aliases.map((alias) => [alias.from, alias.to]));
  const seen = new Set<string>();
  while (aliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = aliases.get(current) ?? current;
  }
  return current;
}

export function promoteEngineeringCode(
  state: EngineeringCodeCurationState,
  rawCode: string,
): EngineeringCodeCurationResult {
  const code = normalizeEngineeringCode(rawCode);
  if (!code) throw new Error("code-curate promote needs a non-blank code");
  const existing = promotedEngineeringCodeSet(state);
  if (existing.has(code)) return { state: normalizeCurationState(state), changed: false };
  return {
    state: normalizeCurationState({
      ...state,
      promoted: [...state.promoted, code],
    }),
    changed: true,
  };
}

export function aliasEngineeringCode(
  state: EngineeringCodeCurationState,
  rawFrom: string,
  rawTo: string,
): EngineeringCodeCurationResult {
  const from = normalizeEngineeringCode(rawFrom);
  const to = normalizeEngineeringCode(rawTo);
  if (!from || !to) throw new Error("code-curate alias needs non-blank from and to codes");
  if (from === to) throw new Error("code-curate alias cannot point a code at itself");

  const existingAliases = new Map(state.aliases.map((alias) => [alias.from, alias.to]));
  existingAliases.set(from, to);
  const next = normalizeCurationState({
    ...state,
    aliases: [...existingAliases.entries()].map(([aliasFrom, aliasTo]) => ({
      from: aliasFrom,
      to: aliasTo,
    })),
  });
  assertNoAliasCycle(next);
  const prev = normalizeCurationState(state);
  return { state: next, changed: stableJson(next) !== stableJson(prev) };
}

export async function loadEngineeringCodeCuration(
  store: Pick<MemoryStore, "kvGet">,
): Promise<EngineeringCodeCurationState> {
  const raw = await store.kvGet<EngineeringCodeCurationState | string>(ENGINEERING_CODE_CURATION_KEY);
  return normalizeCurationState(parseRawState(raw));
}

export async function saveEngineeringCodeCuration(
  store: Pick<MemoryStore, "kvPut">,
  state: EngineeringCodeCurationState,
): Promise<void> {
  await store.kvPut(ENGINEERING_CODE_CURATION_KEY, normalizeCurationState(state));
}

function parseRawState(raw: EngineeringCodeCurationState | string | null): EngineeringCodeCurationState {
  if (raw == null) return { ...EMPTY_ENGINEERING_CODE_CURATION };
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as EngineeringCodeCurationState;
  } catch {
    return { ...EMPTY_ENGINEERING_CODE_CURATION };
  }
}

export function normalizeCurationState(
  state: Partial<EngineeringCodeCurationState> | null | undefined,
): EngineeringCodeCurationState {
  const promoted = Array.isArray(state?.promoted)
    ? sortedUnique(state.promoted.map(normalizeEngineeringCode).filter(Boolean))
    : [];
  const aliases = Array.isArray(state?.aliases)
    ? state.aliases
        .map((alias) => ({
          from: normalizeEngineeringCode(alias.from),
          to: normalizeEngineeringCode(alias.to),
        }))
        .filter((alias) => alias.from && alias.to && alias.from !== alias.to)
    : [];
  const aliasMap = new Map<string, string>();
  for (const alias of aliases) aliasMap.set(alias.from, alias.to);
  return {
    schemaVersion: state?.schemaVersion ?? EXTRACTION_SCHEMA_VERSION,
    suggestedVersion: state?.suggestedVersion ?? EMPTY_ENGINEERING_CODE_CURATION.suggestedVersion,
    promoted,
    aliases: [...aliasMap.entries()]
      .map(([from, to]) => ({ from, to }))
      .sort((a, b) => a.from.localeCompare(b.from)),
  };
}

function assertNoAliasCycle(state: EngineeringCodeCurationState): void {
  for (const alias of state.aliases) {
    const resolved = resolveEngineeringCodeAlias(alias.from, state);
    if (resolved === alias.from) throw new Error(`code-curate alias cycle includes "${alias.from}"`);
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}
