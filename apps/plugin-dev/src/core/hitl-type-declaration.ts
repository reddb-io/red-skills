/**
 * The type label and its `afk.labels.hitl_types` declaration are ONE protection
 * with two halves (#2966, #3013). A `wayfinder:grilling` Ticket routes to a
 * human only while the declaration names that type; the label alone is a
 * trigger with no safety, and it reads to an operator exactly like protection.
 * So whatever installs a HUMAN-ONLY type label declares it in the same act.
 *
 * Pure text surgery on the constrained-subset YAML `.red/config.yaml` uses
 * (see {@link parseConfigYaml}): the operator's comments, key order, and
 * unrelated blocks survive, because a repo's config is hand-written and a
 * re-emitted file would silently discard the parts the parser drops.
 */
import { parseConfigYaml, readHitlTypeLabels } from "./config.js";

/** Every ticket-type label the `/wayfinder` vocabulary installs. */
export const WAYFINDER_TYPE_LABELS: readonly string[] = [
  "wayfinder:research",
  "wayfinder:prototype",
  "wayfinder:grilling",
  "wayfinder:task",
];

/**
 * The HUMAN-ONLY half of that vocabulary — the types a live exchange with a
 * human resolves. `research` and `task` are AFK types and must NOT be declared:
 * a human-only research ticket parks work the agent is meant to run.
 *
 * This is an INSTALLER default, never a routing list: the unblock sweep and the
 * close cascade read the repo's own `afk.labels.hitl_types`, so a repo whose
 * decision tickets are named something else keeps the same protection.
 */
export const WAYFINDER_HITL_TYPE_LABELS: readonly string[] = [
  "wayfinder:grilling",
  "wayfinder:prototype",
];

/** The HUMAN-ONLY types among `labels`, in shipped-vocabulary order. */
export function hitlTypeLabelsAmong(labels: readonly string[]): string[] {
  const installed = new Set(labels.map((label) => label.trim()));
  return WAYFINDER_HITL_TYPE_LABELS.filter((label) => installed.has(label));
}

/**
 * The types a PARSED config declares, from either location the loader honours:
 * the canonical `plugins.dev.afk.labels.hitl_types` or the folded accessor
 * spelling `afk.labels.hitl_types`. {@link parseConfigYaml} hands back the raw
 * dotted keys — the ADR 0042 fold happens in {@link loadConfig} — so a reader
 * that only asked for the accessor form would see a canonically-declared repo
 * as declaring nothing, and re-declare what is already there.
 */
export function declaredHitlTypeLabels(values: Record<string, string | undefined>): string[] {
  const canonical: string[] = [];
  for (let i = 0; ; i += 1) {
    const value = values[`plugins.dev.afk.labels.hitl_types.${i}`];
    if (value === undefined) break;
    if (value.trim() !== "") canonical.push(value.trim());
  }
  if (canonical.length > 0) return canonical;
  const scalar = values["plugins.dev.afk.labels.hitl_types"];
  if (scalar && scalar.trim() !== "") return [scalar.trim()];
  return readHitlTypeLabels(values);
}

export interface HitlTypeDeclarationPlan {
  /** The config text as read (`""` when the file is absent). */
  readonly before: string;
  /** The config text to write; identical to `before` when nothing changed. */
  readonly after: string;
  /** Types this plan adds to the declaration, in request order. */
  readonly added: readonly string[];
  /** Requested types the config already declared. */
  readonly alreadyDeclared: readonly string[];
  readonly changed: boolean;
  /** Unified diff of the insertion, empty when nothing changed. */
  readonly diff: string;
  /** Why no edit was planned despite missing types (malformed config). */
  readonly refusal?: string;
}

const CANONICAL_PATH = ["plugins", "dev", "afk", "labels", "hitl_types"] as const;
const FOLDED_PATH = ["afk", "labels", "hitl_types"] as const;
const DISPLAY_PATH = ".red/config.yaml";

interface KeyLine {
  readonly index: number;
  readonly indent: number;
  readonly path: readonly string[];
  /** `key: value` (a scalar leaf) rather than `key:` (a parent). */
  readonly value: string | null;
}

/** Drop an inline `#` comment that starts outside a quoted scalar. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function indentOf(line: string): number {
  return (line.match(/^\s*/)?.[0] ?? "").length;
}

/** Every mapping key in the file with its dotted path, mirroring the parser's
 * indent stack so a path here means what the loader reads back. */
function scanKeyLines(lines: readonly string[]): KeyLine[] {
  const stack: { key: string; indent: number }[] = [];
  const out: KeyLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = stripComment(lines[index]!.replace(/\r$/, ""));
    if (stripped.trim() === "") continue;
    const indent = indentOf(stripped);
    const rest = stripped.slice(indent).trimEnd();
    if (/^-(\s|$)/.test(rest)) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(rest);
    if (!match) continue;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = match[1]!;
    const value = match[2]!.trim();
    out.push({ index, indent, path: [...stack.map((entry) => entry.key), key], value: value === "" ? null : value });
    if (value === "") stack.push({ key, indent });
  }
  return out;
}

function findPath(keyLines: readonly KeyLine[], path: readonly string[]): KeyLine | undefined {
  return keyLines.find(
    (line) => line.path.length === path.length && line.path.every((key, i) => key === path[i]),
  );
}

/** Index just past the last content line belonging to the block opened at
 * `start` (indent-deeper lines), so an insertion lands inside it. */
function blockEnd(lines: readonly string[], start: number, indent: number): number {
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (indentOf(line) <= indent) break;
    end = i + 1;
  }
  return end;
}

function sequenceItemIndent(lines: readonly string[], key: KeyLine): number {
  for (let i = key.index + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (indent <= key.indent) break;
    if (/^-(\s|$)/.test(line.slice(indent))) return indent;
  }
  return key.indent + 2;
}

function item(indent: number, value: string): string {
  return `${" ".repeat(indent)}- ${value}`;
}

function nestedBlock(indent: number, keys: readonly string[], values: readonly string[]): string[] {
  const out: string[] = [];
  keys.forEach((key, depth) => out.push(`${" ".repeat(indent + depth * 2)}${key}:`));
  const itemIndent = indent + keys.length * 2;
  for (const value of values) out.push(item(itemIndent, value));
  return out;
}

/** Insertion-only unified diff: the operator reviews the lines that appear (and
 * the one scalar line a promotion replaces), not a re-dump of the whole file. */
function renderDiff(
  removed: readonly { line: number; text: string }[],
  inserted: readonly { line: number; text: string }[],
): string {
  if (inserted.length === 0 && removed.length === 0) return "";
  const anchor = (inserted[0]?.line ?? removed[0]!.line) + 1;
  return [
    `--- ${DISPLAY_PATH}`,
    `+++ ${DISPLAY_PATH}`,
    `@@ line ${anchor} @@`,
    ...removed.map((entry) => `-${entry.text}`),
    ...inserted.map((entry) => `+${entry.text}`),
    "",
  ].join("\n");
}

function unchanged(before: string, alreadyDeclared: readonly string[], refusal?: string): HitlTypeDeclarationPlan {
  return { before, after: before, added: [], alreadyDeclared, changed: false, diff: "", refusal };
}

/**
 * Plan the merge of `types` into `afk.labels.hitl_types`.
 *
 * Merges, never overwrites: an existing list is appended to (the repo's own
 * type names survive), an already-declared type is skipped, a single-line
 * scalar declaration is promoted to a list carrying its old value, and a config
 * the loader cannot parse is refused rather than rewritten — a malformed file
 * is already falling back to defaults, and an edit would bury the syntax error.
 */
export function planHitlTypeDeclaration(
  configText: string | null | undefined,
  types: readonly string[],
): HitlTypeDeclarationPlan {
  const before = configText ?? "";
  const wanted = [...new Set(types.map((type) => type.trim()).filter((type) => type !== ""))];

  let declared: string[];
  try {
    declared = declaredHitlTypeLabels(parseConfigYaml(before));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unchanged(before, [], `${DISPLAY_PATH} does not parse (${detail}); repair it, then re-run the installer`);
  }

  const alreadyDeclared = wanted.filter((type) => declared.includes(type));
  const missing = wanted.filter((type) => !declared.includes(type));
  if (missing.length === 0) return unchanged(before, alreadyDeclared);

  const { lines, trailingNewline } = splitLines(before);
  const keyLines = scanKeyLines(lines);
  const declaration = findPath(keyLines, CANONICAL_PATH) ?? findPath(keyLines, FOLDED_PATH);

  const removed: { line: number; text: string }[] = [];
  const inserted: { line: number; text: string }[] = [];
  const next = [...lines];

  if (declaration && declaration.value !== null) {
    // Scalar form (`hitl_types: wayfinder:grilling`) — promote it to a list so
    // the existing single value keeps its meaning alongside the new ones.
    const itemIndent = declaration.indent + 2;
    const promoted = [
      `${" ".repeat(declaration.indent)}hitl_types:`,
      item(itemIndent, declaration.value),
      ...missing.map((type) => item(itemIndent, type)),
    ];
    removed.push({ line: declaration.index, text: lines[declaration.index]! });
    promoted.forEach((text, offset) => inserted.push({ line: declaration.index + offset, text }));
    next.splice(declaration.index, 1, ...promoted);
  } else if (declaration) {
    const itemIndent = sequenceItemIndent(lines, declaration);
    const at = blockEnd(lines, declaration.index, declaration.indent);
    const added = missing.map((type) => item(itemIndent, type));
    added.forEach((text, offset) => inserted.push({ line: at + offset, text }));
    next.splice(at, 0, ...added);
  } else {
    // No declaration yet: hang it off the deepest existing ancestor. The
    // canonical `plugins.dev.*` tree wins whenever it already carries an `afk:`
    // block; a repo whose settings still live in a root-level `afk:` block gets
    // the declaration THERE rather than a rival block the fold would shadow.
    const anchors = [
      ...[4, 3].map((depth) => ({ path: CANONICAL_PATH, depth })),
      ...[2, 1].map((depth) => ({ path: FOLDED_PATH, depth })),
      ...[2, 1].map((depth) => ({ path: CANONICAL_PATH, depth })),
    ];
    let anchor: { key: KeyLine; remainder: readonly string[] } | undefined;
    for (const candidate of anchors) {
      const key = findPath(keyLines, candidate.path.slice(0, candidate.depth));
      if (!key || key.value !== null) continue;
      anchor = { key, remainder: candidate.path.slice(candidate.depth) };
      break;
    }

    if (anchor) {
      const block = nestedBlock(anchor.key.indent + 2, anchor.remainder, missing);
      const at = blockEnd(lines, anchor.key.index, anchor.key.indent);
      block.forEach((text, offset) => inserted.push({ line: at + offset, text }));
      next.splice(at, 0, ...block);
    } else {
      const block = nestedBlock(0, CANONICAL_PATH, missing);
      const at = next.length;
      block.forEach((text, offset) => inserted.push({ line: at + offset, text }));
      next.push(...block);
    }
  }

  const after = next.length === 0 ? "" : `${next.join("\n")}${trailingNewline ? "\n" : ""}`;
  return {
    before,
    after,
    added: missing,
    alreadyDeclared,
    changed: true,
    diff: renderDiff(removed, inserted),
  };
}

export interface TypeLabelInstallDeps {
  /** Idempotently create the label on the issue tracker. */
  ensureLabel(name: string): Promise<void>;
  /** Read `.red/config.yaml`, or `null` when it does not exist. */
  readConfig(): Promise<string | null>;
  writeConfig(text: string): Promise<void>;
}

export interface TypeLabelInstallReceipt {
  /** Labels installed on the tracker, in request order. */
  readonly installed: readonly string[];
  /** HUMAN-ONLY types this run added to `afk.labels.hitl_types`. */
  readonly declared: readonly string[];
  /** HUMAN-ONLY types the config already declared. */
  readonly alreadyDeclared: readonly string[];
  readonly configChanged: boolean;
  /** Why nothing was installed (the declaration could not be written). */
  readonly refusal?: string;
}

/**
 * Install type labels AND their HUMAN-ONLY declaration in one act.
 *
 * The declaration is written FIRST, deliberately: a repo carrying human-only
 * labels that nothing routes is worse than a repo carrying neither, so a config
 * write that cannot happen installs no label at all (#3013).
 */
export async function installTypeLabels(
  labels: readonly string[],
  deps: TypeLabelInstallDeps,
): Promise<TypeLabelInstallReceipt> {
  const requested = [...new Set(labels.map((label) => label.trim()).filter((label) => label !== ""))];
  const hitlTypes = hitlTypeLabelsAmong(requested);
  const configText = await deps.readConfig();
  if (configText === null) {
    // `/red-setup` is the only thing authorized to create a repository's `.red/`
    // (ADR 0067). Without the file there is nowhere to write the safety half, so
    // the trigger half is not installed either.
    return {
      installed: [],
      declared: [],
      alreadyDeclared: [],
      configChanged: false,
      refusal: ".red/config.yaml does not exist; run /red-setup to create it, then re-run the installer",
    };
  }
  const plan = planHitlTypeDeclaration(configText, hitlTypes);
  if (plan.refusal) {
    return { installed: [], declared: [], alreadyDeclared: plan.alreadyDeclared, configChanged: false, refusal: plan.refusal };
  }
  if (plan.changed) await deps.writeConfig(plan.after);
  for (const label of requested) await deps.ensureLabel(label);
  return {
    installed: requested,
    declared: plan.added,
    alreadyDeclared: plan.alreadyDeclared,
    configChanged: plan.changed,
  };
}
