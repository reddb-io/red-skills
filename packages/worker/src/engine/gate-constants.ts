export const CASTLE_VALIDATION_SCHEMA = "red.castle.validation.v2" as const;

export const FEEDBACK_SCRIPTS = ["test", "typecheck", "lint", "build"] as const;
export type FeedbackScript = (typeof FEEDBACK_SCRIPTS)[number];

export const MECHANICAL_KINDS = [
  "formatter",
  "import-organizer",
  "lint-fix",
  "comment-typo",
  "trailing-whitespace",
  "trailing-newline",
] as const;
export type MechanicalKind = (typeof MECHANICAL_KINDS)[number];

export const ROOT_TRIGGER_FILES = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
  ".npmrc",
  ".nvmrc",
] as const;

export const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 10 * 60 * 1000;
export const KILLED_EXIT_CODE = 124;
