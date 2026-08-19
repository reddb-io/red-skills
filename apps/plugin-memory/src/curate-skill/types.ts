/**
 * Curate-skill workflow types. This module is the engine consumed by the
 * `/curate` skill in the dev plugin — the slash command orchestrates the
 * candidate read → consent → archive/restore loop, and the modules here are
 * the pure pieces that loop calls into.
 *
 * The TypeScript code colocates with the Memory plugin to share its tsx /
 * vitest toolchain and the Skill telemetry types; the mutation workflow
 * itself remains the `/curate` skill in `plugins/dev`, so CONTEXT.md's "skill
 * mutation is a workflow outside the Memory plugin" rule is honoured at the
 * workflow level. The Memory CLI never invokes archive or restore.
 */

/** Read-only source kinds — defensively rejected by the archive engine. */
export const READ_ONLY_SOURCE_KINDS = new Set(["plugin", "hub"]);

/**
 * Curator categories the interactive /curate workflow can act on. The full
 * curator emits more (consolidation, restore) but those land in later slices;
 * here we cover every category the brief lists as in-scope.
 */
export const CURATE_CATEGORIES = [
  "stale",
  "abandoned",
  "frequently-failing",
  "archive",
] as const;
export type CurateCategory = (typeof CURATE_CATEGORIES)[number];

export function isCurateCategory(value: string): value is CurateCategory {
  return (CURATE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Shape returned by `memory curate skills --json` for each recommendation. We
 * accept the full report and pick the ones in the `archive` category whose
 * `curatable` flag is true.
 */
export interface CuratorReportRecommendation {
  name: string;
  source_kind: string;
  path: string;
  curatable: boolean;
  category: string;
  reason: string;
}

export interface CuratorReportEnvelope {
  generatedAt: string;
  staleDays: number;
  totalSkills: number;
  curatableSkills: number;
  readOnlySkills: number;
  recommendations: CuratorReportRecommendation[];
}

/** One archive candidate distilled from the curator report. */
export interface ArchiveCandidate {
  name: string;
  source_kind: string;
  /** Absolute path to the skill's SKILL.md file (rollup-provided). */
  path: string;
  reason: string;
  /**
   * The curator category that surfaced this candidate. The interactive
   * workflow groups candidates by category for display and threads the
   * approving category through to the archive manifest as the recorded
   * archive reason.
   */
  category: CurateCategory;
  /** True only when the orchestrator has flagged this skill as pinned. */
  pinned?: boolean;
}

/** Structured outcome from the consent gate. */
export interface ConsentDecision {
  approved: ArchiveCandidate[];
  declined: ArchiveCandidate[];
}

/** Why the archive engine refused a candidate, without any I/O. */
export type RejectionReason =
  | "read-only-source-kind"
  | "pinned"
  | "missing-path"
  | "missing-name";

export interface CandidateRejection {
  name: string;
  reason: RejectionReason;
  detail: string;
}

/** File-level record inside an archive manifest. */
export interface ArchivedFileRecord {
  /** Path relative to the archived skill's root directory. */
  relativePath: string;
  /** SHA-256 of the file contents, hex-encoded. */
  sha256: string;
  byteLength: number;
}

/** Persisted JSON sidecar describing one archived skill. */
export interface ArchiveManifest {
  name: string;
  /** Absolute path of the skill's original root directory. */
  originalRoot: string;
  /** Where SKILL.md lived under `originalRoot` (always `SKILL.md` in practice). */
  skillFileRelative: string;
  source_kind: string;
  archivedAt: string;
  /**
   * The curator category that justified the archive (`stale`, `abandoned`,
   * `frequently-failing`, `archive`). Optional for backward compatibility
   * with manifests written by the tracer slice before per-category curation
   * landed.
   */
  category?: CurateCategory;
  /** Free-form evidence string copied from the curator report. */
  reason: string;
  files: ArchivedFileRecord[];
}

export interface ArchiveReceipt {
  name: string;
  originalRoot: string;
  archiveRoot: string;
  manifestPath: string;
  files: ArchivedFileRecord[];
}

export interface RestoreReceipt {
  name: string;
  archiveRoot: string;
  restoredRoot: string;
  files: ArchivedFileRecord[];
}
