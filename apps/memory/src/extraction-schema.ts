import { GRAPH_CONTRACT_VERSION } from "./graph-contract.js";

/**
 * Extraction schema — the two-axis model behind ADR 0035.
 *
 * The Memory plugin used to conflate two genuinely different axes onto a single
 * "node type". This module splits them and makes the closed axis the single
 * source of truth for the two validation profiles, so they cannot drift:
 *
 *  - **Structural type** — a closed, small vocabulary of node kinds with distinct
 *    edge/query/storage behaviour (`file`, `symbol`, `concept`, `issue`, `prd`,
 *    `attempt`, `validation`, …). One of them, {@link BASE_STRUCTURAL_TYPE}, is
 *    the home a non-structural proposed kind resolves to.
 *  - **Engineering code** — an open, growable axis for the fine-grained semantic
 *    classification (the "why"/kind: `decision`, `gotcha`, `risk`, `root-cause`,
 *    …), modelled on TigerBeetle's `code`. The schema ships a *suggested*
 *    vocabulary; unknown codes are admitted, never gated.
 *
 * Two profiles are derived from the one structural vocabulary by
 * {@link deriveExtractionProfiles}:
 *
 *  - **strict-write** — validates the structural type of provider-backed
 *    (`INFERRED`) extraction. In-vocabulary kinds pass as themselves; anything
 *    else resolves to {@link BASE_STRUCTURAL_TYPE} (never an error, never a
 *    quarantine) while the proposed kind is preserved as an engineering code.
 *  - **lossless-read** — the existing open graph contract (ADR's "export never
 *    breaks a consumer"). Unknown structural types and edge labels still
 *    round-trip; its version tracks {@link GRAPH_CONTRACT_VERSION}.
 *
 * Both profiles share the *same* frozen structural set by reference, so the
 * "one vocabulary, two profiles" guarantee is structural, not a convention a
 * future edit could quietly violate.
 */

/** Schema version of the extraction vocabulary contract. */
export const EXTRACTION_SCHEMA_VERSION = "1.1.0";

/**
 * The closed structural-type vocabulary — node kinds with distinct
 * edge/query/storage behaviour. This is the single source of truth the
 * strict-write and lossless-read profiles are derived from. Growing it is a
 * versioned, deliberate change (bump {@link EXTRACTION_SCHEMA_VERSION}); it is
 * never grown implicitly by an inferred fact.
 */
export const STRUCTURAL_TYPES = [
  // Code graph
  "file",
  "import",
  "symbol",
  // Generic semantic anchor / base home
  "concept",
  // Actors and lifecycle artifacts (distinct tier/storage behaviour)
  "person",
  "session",
  "transcript",
  // Work items (mirror the native task surface)
  "task",
  "goal",
  "workflow",
  // Reasoning trace (distinct `reasoning` tier)
  "why_note",
  // AFK engineering semantic graph (PRD #95)
  "worker",
  "issue",
  "prd",
  "validation",
] as const;

export type StructuralType = (typeof STRUCTURAL_TYPES)[number];

/**
 * The base structural type a non-structural proposed kind resolves to. Every
 * inferred fact therefore always has a valid structural home — strict-write
 * never rejects and there is no `needs-review` quarantine (ADR 0035).
 */
export const BASE_STRUCTURAL_TYPE: StructuralType = "concept";

/**
 * The *suggested* engineering-code vocabulary: the open, growable axis carrying
 * the fine-grained "why"/kind. It is guidance, not a gate — unknown codes are
 * admitted. Recurring unknown codes can be promoted into this list through the
 * explicit code-curation overlay, or aliased to a canonical code.
 */
export const SUGGESTED_ENGINEERING_CODES = [
  "decision",
  "problem",
  "solution",
  "fix",
  "root-cause",
  "gotcha",
  "risk",
  "constraint",
  "rationale",
  "pitfall",
  "workaround",
  "invariant",
  "tradeoff",
] as const;

export type SuggestedEngineeringCode = (typeof SUGGESTED_ENGINEERING_CODES)[number];

const SUGGESTED_CODE_SET: ReadonlySet<string> = new Set(SUGGESTED_ENGINEERING_CODES);

/** Normalize a proposed engineering code to a stable kebab-case slug. */
export function normalizeEngineeringCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether a code is in the suggested vocabulary. This is *visibility only* — an
 * unknown code is still a valid engineering code; the axis is growable and never
 * gated on this answer.
 */
export function isSuggestedEngineeringCode(code: string): boolean {
  return SUGGESTED_CODE_SET.has(normalizeEngineeringCode(code));
}

/** Outcome of resolving a proposed kind against the strict-write profile. */
export interface StructuralResolution {
  /** The valid structural home. In-vocabulary kinds map to themselves. */
  structuralType: StructuralType;
  /** True when the proposed kind was already in the closed vocabulary. */
  inVocabulary: boolean;
  /**
   * The proposed kind preserved as an open engineering code when it fell back to
   * the base type; `null` when the kind was itself structural. This is the seam
   * that keeps the classification usable rather than discarding it.
   */
  engineeringCode: string | null;
}

/**
 * strict-write profile — validates the structural axis of provider-backed
 * inference. It resolves, it never rejects.
 */
export interface StrictWriteProfile {
  readonly version: string;
  readonly structuralTypes: ReadonlySet<string>;
  readonly baseStructuralType: StructuralType;
  isStructural(kind: string): kind is StructuralType;
  /** Resolve a proposed kind to a valid structural home. Never throws. */
  resolve(kind: string): StructuralResolution;
}

/**
 * lossless-read profile — the open graph-contract export contract. Every type
 * round-trips, structural or not, so a new structural type or edge label never
 * breaks a consumer.
 */
export interface LosslessReadProfile {
  readonly version: string;
  readonly structuralTypes: ReadonlySet<string>;
  isStructural(kind: string): kind is StructuralType;
  /** Open contract: every value round-trips. Always true, by design. */
  roundTrips(type: string): boolean;
}

export interface ExtractionProfiles {
  /** Version of the structural vocabulary both profiles were derived from. */
  version: string;
  strictWrite: StrictWriteProfile;
  losslessRead: LosslessReadProfile;
}

/**
 * Derive the strict-write and lossless-read profiles from a single structural
 * vocabulary. Both profiles hold the *same* frozen set by reference, so they
 * cannot diverge: there is no second copy a future edit could change in
 * isolation. This is the seam every other slice in this track depends on.
 */
export function deriveExtractionProfiles(
  structuralTypes: readonly string[] = STRUCTURAL_TYPES,
  options: { version?: string; baseStructuralType?: StructuralType } = {},
): ExtractionProfiles {
  const version = options.version ?? EXTRACTION_SCHEMA_VERSION;
  const base = options.baseStructuralType ?? BASE_STRUCTURAL_TYPE;

  // One shared, frozen vocabulary — handed to both profiles by reference.
  const shared: ReadonlySet<string> = Object.freeze(new Set(structuralTypes));
  if (!shared.has(base)) {
    throw new Error(
      `base structural type "${base}" must be a member of the structural vocabulary`,
    );
  }

  const isStructural = (kind: string): kind is StructuralType => shared.has(kind);

  const strictWrite: StrictWriteProfile = {
    version,
    structuralTypes: shared,
    baseStructuralType: base,
    isStructural,
    resolve(kind: string): StructuralResolution {
      const proposed = typeof kind === "string" ? kind.trim() : "";
      if (shared.has(proposed)) {
        return { structuralType: proposed as StructuralType, inVocabulary: true, engineeringCode: null };
      }
      const code = normalizeEngineeringCode(proposed);
      return { structuralType: base, inVocabulary: false, engineeringCode: code || null };
    },
  };

  const losslessRead: LosslessReadProfile = {
    // The read profile's version tracks the export contract it speaks for.
    version: GRAPH_CONTRACT_VERSION,
    structuralTypes: shared, // SAME reference as strict-write — cannot drift.
    isStructural,
    roundTrips: () => true,
  };

  return { version, strictWrite, losslessRead };
}

/** The canonical profiles, derived once from the closed structural vocabulary. */
export const EXTRACTION_PROFILES = deriveExtractionProfiles();
