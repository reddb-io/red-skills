/**
 * Cache-prefix stability (PRD #820, issue #828).
 *
 * Provider KV caches only hit when the *front* of a prompt is byte-identical
 * across calls. Prompts emitted by memory (context packs, the cross-agent
 * handoff brief reused for AFK handoffs) interleave stable structure — headers,
 * titles, summaries, citations — with per-run dynamic tokens (timestamps, ages,
 * generated ids). A single changed timestamp near the top busts the cache for
 * the whole prompt.
 *
 * `stabilizeCachePrefix` performs a behavior-preserving pass that relocates the
 * dynamic *values* to the end of the prompt, leaving stable placeholders inline.
 * The result keeps every byte of information (the values are listed verbatim in
 * a trailing block) while making the long stable prefix invariant run-to-run,
 * so the provider can reuse its cached prefix.
 */

/** Marker that opens the relocated-values block. Everything before it is the
 * cache-stable prefix; everything from it onward is the per-run dynamic tail. */
export const VOLATILE_MARKER =
  "<!-- volatile: dynamic values relocated to the end for cache-prefix stability -->";

const placeholder = (index: number): string => `[[v${index}]]`;

/**
 * Patterns for dynamic tokens that legitimately change between otherwise
 * identical runs. Ordered most-specific-first so the alternation matches the
 * widest meaningful token at each position.
 *
 * Stable identifiers that do NOT change run-to-run (recall scores, importance,
 * citation rids within a store) are intentionally excluded — relocating them
 * would shrink, not grow, the stable prefix.
 */
const DYNAMIC_PATTERN_SOURCES: readonly string[] = [
  // ISO-8601 timestamps (with or without milliseconds / timezone offset).
  "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})?",
  // RFC v4-style UUIDs.
  "\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b",
  // Relative ages emitted by handoff briefs: "8d old", "12 days old".
  "\\b\\d+\\s*d(?:ays?)?\\s+old\\b",
  // Epoch milliseconds (13 contiguous digits).
  "\\b\\d{13}\\b",
  // Long hex blobs (commit shas, content hashes).
  "\\b[0-9a-f]{12,}\\b",
];

const buildDynamicRegExp = (): RegExp =>
  new RegExp(DYNAMIC_PATTERN_SOURCES.join("|"), "g");

/** True when `text` contains at least one dynamic token. */
export function containsDynamicToken(text: string): boolean {
  return buildDynamicRegExp().test(text);
}

export interface StabilizedPrompt {
  /** The full stabilized prompt: stable prefix + relocated-values block. */
  text: string;
  /** The cache-stable prefix — guaranteed free of dynamic tokens. */
  stablePrefix: string;
  /** Dynamic values relocated to the end, in first-seen order. */
  volatileValues: string[];
  /** Number of dynamic values relocated (0 means `text` was already stable). */
  relocatedCount: number;
}

/**
 * Relocate every dynamic token in `text` to a trailing block, replacing each
 * inline occurrence with a stable `[[vN]]` placeholder numbered by first
 * appearance. Two prompts that differ only in their dynamic values produce an
 * identical `stablePrefix`. When `text` has no dynamic tokens it is returned
 * unchanged with `relocatedCount === 0` (a safe no-op).
 */
export function stabilizeCachePrefix(text: string): StabilizedPrompt {
  const volatileValues: string[] = [];
  const stablePrefix = text.replace(buildDynamicRegExp(), (match) => {
    volatileValues.push(match);
    return placeholder(volatileValues.length);
  });

  if (volatileValues.length === 0) {
    return { text, stablePrefix: text, volatileValues: [], relocatedCount: 0 };
  }

  const block = [
    VOLATILE_MARKER,
    ...volatileValues.map((value, index) => `${placeholder(index + 1)} = ${value}`),
  ].join("\n");

  return {
    text: `${stablePrefix}\n\n${block}`,
    stablePrefix,
    volatileValues,
    relocatedCount: volatileValues.length,
  };
}
