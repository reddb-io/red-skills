/**
 * mutation-plan — the mutant MODEL: what a single-token change is, and the two
 * pure operations every stage of the check performs on one.
 *
 * Separate from the planner that produces mutants because the planner needs the
 * TypeScript compiler and this does not. That boundary is enforced, not merely
 * observed: the compiler must never reach the shipped MCP bundle
 * (`toon-json-guard`'s bundle rule), so the one module that imports it is
 * declared as a compiler module and nothing in the bundle's reach may import
 * that module. The budgeted runner and the review stage need the mutant model,
 * not the parser — so the model lives here, where both can have it for free.
 */

/** The closed set of swaps. Each id names ONE kind of behaviour change. */
export type MutationOperatorId =
  /** `<` ↔ `<=`, `>` ↔ `>=` — the off-by-one a boundary test catches. */
  | "conditional-boundary"
  /** `===` ↔ `!==`, `==` ↔ `!=` — the branch taken is inverted. */
  | "negate-conditional"
  /** `+` ↔ `-`, `*` ↔ `/` — the value computed is wrong. */
  | "arithmetic"
  /** `&&` ↔ `||` — the composition of two conditions is inverted. */
  | "logical"
  /** `true` ↔ `false` — a constant the code leans on. */
  | "boolean-literal";

export const MUTATION_OPERATOR_IDS: readonly MutationOperatorId[] = [
  "conditional-boundary",
  "negate-conditional",
  "arithmetic",
  "logical",
  "boolean-literal",
];

/** One file the mutator may touch, with the diff lines that make it eligible. */
export interface MutationSource {
  /** Repo-relative path, carried into every mutant id. */
  readonly path: string;
  readonly text: string;
  /** 1-based lines this publish's diff added or changed in this file. */
  readonly changedLines: readonly number[];
}

/** One single-token change to one file. */
export interface Mutant {
  /** `<path>:<line>:<operator>#<ordinal>` — stable across runs, safe in a log line. */
  readonly id: string;
  readonly path: string;
  /** 1-based line of the token being replaced. */
  readonly line: number;
  readonly operator: MutationOperatorId;
  /** The token as written. */
  readonly original: string;
  /** The token that replaces it. */
  readonly replacement: string;
  /** Byte offsets of the token in the ORIGINAL text. */
  readonly start: number;
  readonly end: number;
}

export interface MutationPlanOptions {
  /** Hard ceiling on mutants planned across all files. */
  readonly maxMutants?: number;
}

/** How many mutants one publish may plan when the caller states no ceiling. */
export const DEFAULT_MAX_MUTANTS = 40;

/**
 * The mutated text for one mutant. PURE — the caller owns where it is written.
 *
 * Offsets come from the same parse that produced the mutant, so applying a
 * mutant to text it was not planned against is a caller error the offsets
 * cannot detect; every caller in this repo hands back the exact source it
 * planned from.
 */
export function applyMutant(text: string, mutant: Mutant): string {
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
}

/** One line naming what a mutant changed, for a survivor list a human reads. PURE. */
export function describeMutant(mutant: Mutant): string {
  return `${mutant.path}:${mutant.line} ${mutant.original} → ${mutant.replacement} (${mutant.operator})`;
}
