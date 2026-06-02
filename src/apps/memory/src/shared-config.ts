/**
 * shared-config.ts — the unified `.red/config.yaml` seam for the memory plugin
 * (ADR 0042).
 *
 * Memory configuration is namespaced under `plugins.memory` in the single
 * repo-wide `.red/config.yaml`, the same file `dev` reads under `plugins.dev`.
 * It is written once by the `memory init` wizard and read-only thereafter, so
 * the block is **sparse**: only `mode` is mandatory; every other field is
 * emitted only when it differs from the documented default, and derivable
 * fields (`reddb` from `mode`, `version` constant) are never persisted.
 *
 * No YAML dependency: this module parses/emits the same constrained-subset
 * grammar `dev`'s config parser uses (2-space-indented nested mappings, scalar
 * leaves). Reads are best-effort (a malformed line is skipped, never thrown);
 * the wizard owns the only writes.
 */

import type { AiProviderConfig } from "./extract-conversation.js";
import {
  CONFIG_VERSION,
  DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
  DEFAULT_L2_BYTE_BUDGET,
  DEFAULT_L2_TTL_MS,
  DEFAULT_NOTES_DIR,
  DEFAULT_STORE_PATH,
  HOOKS_OFF,
  type HookConfig,
  type MemoryConfig,
  type StorageMode,
} from "./config.js";

const STORAGE_MODES: readonly StorageMode[] = ["markdown-only", "graph", "hybrid"];

/**
 * Best-effort parse of the constrained-subset grammar into a `dotted.key ->
 * value` map. Unlike `dev`'s parser this never throws — a line that violates
 * the grammar is skipped, so a hand-edited file can never crash a read.
 */
export function parseYamlFlat(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [];
  const indents: number[] = [];

  for (const rawLine of text.split("\n")) {
    let line = rawLine.replace(/\r$/, "");

    // strip inline comments unless the line carries a quoted string
    if (!/".*"/.test(line) && !/'.*'/.test(line)) {
      const hash = line.indexOf("#");
      if (hash >= 0) line = line.slice(0, hash);
    }
    if (line.replace(/\s/g, "") === "") continue;

    const indent = (line.match(/^ */)?.[0] ?? "").length;
    if (indent % 2 !== 0) continue; // skip odd-indent lines rather than throw
    const rest = line.slice(indent).replace(/\s+$/, "");
    const colon = rest.indexOf(":");
    if (colon < 0 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(rest.slice(0, colon))) continue;

    const key = rest.slice(0, colon);
    let value = rest.slice(colon + 1).replace(/^\s+/, "");
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);

    while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
      stack.pop();
      indents.pop();
    }
    const full = stack.length > 0 ? `${stack.join(".")}.${key}` : key;
    if (value === "") {
      stack.push(key);
      indents.push(indent);
    } else {
      out[full] = value;
    }
  }
  return out;
}

function asBool(v: string | undefined): boolean {
  return v === "true";
}

/**
 * Reconstruct a full {@link MemoryConfig} from the `plugins.memory` block of a
 * `.red/config.yaml`. Returns `null` when there is no such block (no
 * `plugins.memory.mode`), which is the "memory not configured here" signal.
 * Defaults are applied and derivable fields reconstructed so the returned
 * object is indistinguishable from a legacy JSON read.
 */
export function parsePluginsMemory(text: string): MemoryConfig | null {
  const flat = parseYamlFlat(text);
  const p = "plugins.memory.";
  const mode = flat[`${p}mode`];
  if (!mode || !STORAGE_MODES.includes(mode as StorageMode)) return null;

  const hooks: HookConfig = { ...HOOKS_OFF };
  if (asBool(flat[`${p}hooks.sessionStart`])) hooks.sessionStart = true;
  if (asBool(flat[`${p}hooks.postToolUse`])) hooks.postToolUse = true;
  if (asBool(flat[`${p}hooks.stop`])) hooks.stop = true;
  if (asBool(flat[`${p}hooks.preCompact`])) hooks.preCompact = true;

  const config: MemoryConfig = {
    version: CONFIG_VERSION,
    mode: mode as StorageMode,
    notesDir: flat[`${p}notesDir`] ?? DEFAULT_NOTES_DIR,
    hooks,
    mcp: asBool(flat[`${p}mcp`]),
    reddb: mode !== "markdown-only", // derived, never persisted
  };

  if (flat[`${p}storePath`] !== undefined) config.storePath = flat[`${p}storePath`];
  if (asBool(flat[`${p}skillTelemetry`])) config.skillTelemetry = true;

  const retention = Number(flat[`${p}eventLog.retentionDays`]);
  if (Number.isFinite(retention) && retention > 0) config.eventLog = { retentionDays: retention };

  const ttlMs = Number(flat[`${p}l2.ttlMs`]);
  const byteBudget = Number(flat[`${p}l2.byteBudget`]);
  const l2: { ttlMs?: number; byteBudget?: number } = {};
  if (Number.isFinite(ttlMs) && ttlMs > 0) l2.ttlMs = ttlMs;
  if (Number.isFinite(byteBudget) && byteBudget > 0) l2.byteBudget = byteBudget;
  if (l2.ttlMs !== undefined || l2.byteBudget !== undefined) config.l2 = l2;

  const provider: Record<string, string> = {};
  for (const [k, v] of Object.entries(flat)) {
    const m = k.startsWith(`${p}provider.`) ? k.slice(`${p}provider.`.length) : undefined;
    if (m) provider[m] = v;
  }
  if (Object.keys(provider).length > 0) config.provider = provider as unknown as AiProviderConfig;

  return config;
}

function quoteIfNeeded(value: string): string {
  return /[#:]|^\s|\s$/.test(value) ? `"${value}"` : value;
}

/**
 * The sparse `plugins.memory` subtree as indented YAML lines (starting at the
 * `  memory:` header, indent 2). Only non-default fields are emitted; `reddb`
 * and `version` are dropped (derived/constant).
 */
export function emitMemoryBlockLines(config: MemoryConfig): string[] {
  const lines: string[] = ["  memory:"];
  lines.push(`    mode: ${config.mode}`);
  if (config.notesDir && config.notesDir !== DEFAULT_NOTES_DIR)
    lines.push(`    notesDir: ${quoteIfNeeded(config.notesDir)}`);
  if (config.storePath !== undefined && config.storePath !== DEFAULT_STORE_PATH)
    lines.push(`    storePath: ${quoteIfNeeded(config.storePath)}`);
  if (config.mcp) lines.push("    mcp: true");
  if (config.skillTelemetry) lines.push("    skillTelemetry: true");

  const onHooks = (Object.keys(config.hooks) as (keyof HookConfig)[]).filter((h) => config.hooks[h]);
  if (onHooks.length > 0) {
    lines.push("    hooks:");
    for (const h of onHooks) lines.push(`      ${h}: true`);
  }

  if (config.eventLog && config.eventLog.retentionDays !== DEFAULT_MEMORY_EVENT_RETENTION_DAYS) {
    lines.push("    eventLog:");
    lines.push(`      retentionDays: ${config.eventLog.retentionDays}`);
  }

  if (config.l2) {
    const sub: string[] = [];
    if (config.l2.ttlMs !== undefined && config.l2.ttlMs !== DEFAULT_L2_TTL_MS)
      sub.push(`      ttlMs: ${config.l2.ttlMs}`);
    if (config.l2.byteBudget !== undefined && config.l2.byteBudget !== DEFAULT_L2_BYTE_BUDGET)
      sub.push(`      byteBudget: ${config.l2.byteBudget}`);
    if (sub.length > 0) {
      lines.push("    l2:");
      lines.push(...sub);
    }
  }

  if (config.provider) {
    lines.push("    provider:");
    for (const [k, v] of Object.entries(config.provider as unknown as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      lines.push(`      ${k}: ${typeof v === "string" ? quoteIfNeeded(v) : String(v)}`);
    }
  }
  return lines;
}

function lineIndent(line: string): number {
  return (line.match(/^ */)?.[0] ?? "").length;
}

function isStructural(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

function topKey(line: string): string {
  return line.replace(/^ */, "").replace(/:.*$/, "").trim();
}

/**
 * Merge the sparse `plugins.memory` block into an existing `.red/config.yaml`,
 * preserving everything else (global keys, a `plugins.dev` sibling, comments).
 * Replaces an existing `plugins.memory` subtree in place, inserts one under an
 * existing `plugins:` mapping, or appends a new `plugins:` block. Returns the
 * new file text with a single trailing newline.
 */
export function mergeMemoryBlock(existingText: string, config: MemoryConfig): string {
  const memoryLines = emitMemoryBlockLines(config);
  const lines = existingText === "" ? [] : existingText.replace(/\n+$/, "").split("\n");

  // locate a top-level `plugins:` mapping
  let pluginsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isStructural(lines[i]!) && lineIndent(lines[i]!) === 0 && topKey(lines[i]!) === "plugins") {
      pluginsIdx = i;
      break;
    }
  }

  if (pluginsIdx === -1) {
    const out = [...lines];
    if (out.length > 0 && out[out.length - 1]!.trim() !== "") out.push("");
    out.push("plugins:", ...memoryLines);
    return `${out.join("\n")}\n`;
  }

  // within the plugins block, find an existing `memory:` child (indent 2)
  let memStart = -1;
  for (let i = pluginsIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isStructural(line)) continue;
    const indent = lineIndent(line);
    if (indent === 0) break; // left the plugins block
    if (indent === 2 && topKey(line) === "memory") {
      memStart = i;
      break;
    }
  }

  if (memStart === -1) {
    // insert the memory block right after the `plugins:` header line
    const out = [...lines];
    out.splice(pluginsIdx + 1, 0, ...memoryLines);
    return `${out.join("\n")}\n`;
  }

  // replace the existing memory subtree: from memStart up to (exclusive) the
  // next structural line at indent <= 2, backing up over trailing blanks so a
  // separator before a sibling is preserved.
  let memEnd = lines.length;
  for (let i = memStart + 1; i < lines.length; i++) {
    if (isStructural(lines[i]!) && lineIndent(lines[i]!) <= 2) {
      memEnd = i;
      break;
    }
  }
  while (memEnd - 1 > memStart && lines[memEnd - 1]!.trim() === "") memEnd--;

  const out = [...lines.slice(0, memStart), ...memoryLines, ...lines.slice(memEnd)];
  return `${out.join("\n")}\n`;
}
