import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pre-ingest scoping: the deep module behind the `memory ingest` scope wizard
 * (#235). Everything here is a pure function over a *file list* + *ignore
 * patterns* — counting candidates, resolving a scope preset, and
 * rendering/parsing the committed `.memoryignore` artifact — so it is testable
 * in isolation from the interactive CLI prompt. The only impure surface is the
 * thin {@link readMemoryIgnore}/{@link writeMemoryIgnore} fs shell at the bottom.
 */

/** The committed, human-editable ignore artifact. Lives at the repo root. */
export const MEMORY_IGNORE_FILENAME = ".memoryignore";

// --- glob matching ----------------------------------------------------------

const REGEX_SPECIALS = new Set([".", "+", "^", "$", "(", ")", "[", "]", "|", "\\"]);

function escapeLiteral(text: string): string {
  let out = "";
  for (const ch of text) out += REGEX_SPECIALS.has(ch) ? `\\${ch}` : ch;
  return out;
}

/**
 * Translate a fast-glob-style pattern into an anchored RegExp. Supports the
 * subset the ingest pipeline and presets actually use: `**` (globstar),
 * `**​/` (zero-or-more leading dirs), `*` (within a segment), `?`, and
 * `{a,b}` alternation. A single `*` never crosses a `/`.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 1; // consume the second star
        if (glob[i + 1] === "/") {
          i += 1; // consume the slash; `**​/` matches zero or more dirs
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      let body = "";
      let j = i + 1;
      while (j < glob.length && glob[j] !== "}") {
        body += glob[j];
        j += 1;
      }
      i = j; // consume through the closing brace
      const alts = body.split(",").map((alt) => escapeLiteral(alt));
      re += `(?:${alts.join("|")})`;
    } else {
      re += escapeLiteral(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** True when `path` matches any of the glob `patterns`. */
export function matchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

/**
 * Count how many files survive a set of ignore patterns. Pure: the candidate
 * count the wizard reports is exactly `countCandidates(files, ignore)`.
 */
export function countCandidates(files: string[], ignore: string[]): number {
  if (ignore.length === 0) return files.length;
  return files.filter((file) => !matchesAnyPattern(file, ignore)).length;
}

// --- scope presets ----------------------------------------------------------

export type ScopePresetName = "core" | "libs" | "proceed" | "generate-ignore";

export interface ScopePreset {
  name: ScopePresetName;
  label: string;
  description: string;
  /** Extra ignore globs layered on top of the ingest defaults for this preset. */
  ignore: string[];
}

const TEST_AND_FIXTURE_IGNORES = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/examples/**",
  "**/example/**",
  "**/fixtures/**",
  "**/__mocks__/**",
  "**/*.stories.*",
];

export const SCOPE_PRESETS: Record<ScopePresetName, ScopePreset> = {
  proceed: {
    name: "proceed",
    label: "proceed",
    description: "Graph every candidate file (no extra scoping).",
    ignore: [],
  },
  core: {
    name: "core",
    label: "core only",
    description:
      "Graph core application/source code only — skip tests, examples, vendored and library trees.",
    ignore: [...TEST_AND_FIXTURE_IGNORES, "**/vendor/**", "**/libs/**", "**/packages/**"],
  },
  libs: {
    name: "libs",
    label: "libs only",
    description:
      "Graph shared library/package code only — skip application trees, tests and examples.",
    ignore: [...TEST_AND_FIXTURE_IGNORES, "**/apps/**", "**/app/**"],
  },
  "generate-ignore": {
    name: "generate-ignore",
    label: "generate ignore file",
    description: `Write a committed, editable ${MEMORY_IGNORE_FILENAME} and stop — no ingest this run.`,
    ignore: [],
  },
};

/**
 * Resolve a preset by name. `undefined` (no `--scope` flag) defaults to
 * `proceed`; an unrecognised name throws with the list of valid presets.
 */
export function resolvePreset(name: string | undefined): ScopePreset {
  if (name == null) return SCOPE_PRESETS.proceed;
  const preset = SCOPE_PRESETS[name as ScopePresetName];
  if (!preset) {
    throw new Error(
      `unknown ingest scope "${name}" — choose one of: ${Object.keys(SCOPE_PRESETS).join(", ")}`,
    );
  }
  return preset;
}

// --- scope plan + report ----------------------------------------------------

export interface ScopePlan {
  preset: ScopePreset;
  total: number;
  candidates: number;
  ignored: number;
  /** The full ignore set applied to reach `candidates` (preset + extras). */
  ignore: string[];
}

/**
 * Plan a scoped ingest over an already-collected candidate file list. Layers
 * any `extraIgnore` (e.g. a committed `.memoryignore`) on top of the preset's
 * own ignore globs. Pure — no filesystem access.
 */
export function planScope(
  files: string[],
  presetName: string | undefined,
  extraIgnore: string[] = [],
): ScopePlan {
  const preset = resolvePreset(presetName);
  const ignore = [...preset.ignore, ...extraIgnore];
  const candidates = countCandidates(files, ignore);
  return {
    preset,
    total: files.length,
    candidates,
    ignored: files.length - candidates,
    ignore,
  };
}

/** Human-readable scope report — the candidate count shown before processing. */
export function formatScopeReport(plan: ScopePlan): string {
  const lines = [
    `memory ingest scope: ${plan.preset.label}`,
    `  ${plan.candidates} candidate file(s) of ${plan.total} (${plan.ignored} ignored)`,
    `  ${plan.preset.description}`,
  ];
  return lines.join("\n");
}

// --- ignore file render / parse ---------------------------------------------

/** Sensible starter ignore globs for a freshly generated `.memoryignore`. */
export function defaultIgnorePatterns(): string[] {
  return [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/out/**",
    "**/coverage/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/.cache/**",
    "**/vendor/**",
    "**/__snapshots__/**",
    "**/*.min.js",
    "**/*.map",
    "**/*.snap",
  ];
}

const IGNORE_FILE_HEADER = [
  `# ${MEMORY_IGNORE_FILENAME} — files excluded from \`memory ingest\`.`,
  "# One glob per line (fast-glob syntax). Lines starting with # are comments.",
  "# Commit this file so the whole team shares the same graph scope. Edit freely.",
  "",
];

/** Render an ignore file with a human-editable header + one glob per line. */
export function renderIgnoreFile(patterns: string[]): string {
  return [...IGNORE_FILE_HEADER, ...patterns, ""].join("\n");
}

/** Parse `.memoryignore` content: drop blank lines and `#` comments. */
export function parseMemoryIgnore(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// --- fs shell (the only impure surface) -------------------------------------

/** Read the committed `.memoryignore` at `cwd`; returns `[]` when absent. */
export async function readMemoryIgnore(cwd: string): Promise<string[]> {
  try {
    return parseMemoryIgnore(await readFile(join(cwd, MEMORY_IGNORE_FILENAME), "utf8"));
  } catch {
    return [];
  }
}

/** Write a `.memoryignore` at `cwd` and return the path written. */
export async function writeMemoryIgnore(cwd: string, patterns: string[]): Promise<string> {
  const path = join(cwd, MEMORY_IGNORE_FILENAME);
  await writeFile(path, renderIgnoreFile(patterns), "utf8");
  return path;
}
