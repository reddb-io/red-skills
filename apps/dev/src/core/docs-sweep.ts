// docs-sweep — pure decision logic for the /afk boot Docs Sweep.
//
// The runtime owns git/gh/filesystem effects. This module only classifies .red/
// documentation paths and turns discovered file states into a clean/land/halt
// plan.

export type DocsSweepAction = "clean" | "land" | "halt";
export type DocsSweepFileStateKind = "modified" | "untracked" | "ahead";
export type DocsSweepPathGroup = "glossary" | "adr" | "operational" | "other";
export type DocsSweepHaltReason = "origin-unreachable" | "zero-precedent" | "landing-failed";

export interface DocsSweepFileState {
  path: string;
  state: DocsSweepFileStateKind;
  group: DocsSweepPathGroup;
  /** True when git reports the path through an ignored status (`!!`). */
  ignored: boolean;
  /** Whether origin/{base} already tracks at least one file in this path class. */
  trackedPrecedent: boolean;
}

export interface DocsSweepInput {
  base: string;
  files: readonly DocsSweepFileState[];
  /** False means the caller could not freshly verify origin/{base}. */
  originReachable?: boolean;
}

export interface DocsSweepPlan {
  action: DocsSweepAction;
  base: string;
  files: DocsSweepFileState[];
  haltReason?: DocsSweepHaltReason;
}

const OPERATIONAL_PREFIXES = [
  ".red/tmp/",
  ".red/wiki/",
  ".red/memory/",
  ".red/brain/",
  ".red/state/",
];

export function normalizeDocsPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function classifyDocsPath(path: string): DocsSweepPathGroup {
  const p = normalizeDocsPath(path);
  if (OPERATIONAL_PREFIXES.some((prefix) => p.startsWith(prefix))) return "operational";
  if (p === ".red/CONTEXT.md" || p === ".red/CONTEXT-MAP.md" || p.startsWith(".red/contexts/")) {
    return "glossary";
  }
  if (p.startsWith(".red/adr/")) return "adr";
  return "other";
}

function isSweepDoc(file: DocsSweepFileState): boolean {
  const group = file.group === "other" ? classifyDocsPath(file.path) : file.group;
  return group === "glossary" || group === "adr";
}

export function planDocsSweep(input: DocsSweepInput): DocsSweepPlan {
  const files = input.files
    .map((f) => ({ ...f, path: normalizeDocsPath(f.path), group: f.group === "other" ? classifyDocsPath(f.path) : f.group }))
    .filter(isSweepDoc)
    .sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    return { action: "clean", base: input.base, files: [], haltReason: undefined };
  }

  if (input.originReachable === false) {
    return { action: "halt", base: input.base, files, haltReason: "origin-unreachable" };
  }

  if (files.some((f) => f.ignored && !f.trackedPrecedent)) {
    return { action: "halt", base: input.base, files, haltReason: "zero-precedent" };
  }

  return { action: "land", base: input.base, files, haltReason: undefined };
}

export function renderDocsSweepFileList(files: readonly Pick<DocsSweepFileState, "path" | "state">[]): string {
  return files.map((f) => `${f.state}:${normalizeDocsPath(f.path)}`).join(",");
}
