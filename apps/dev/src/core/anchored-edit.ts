// anchored-edit - byte-exact anchored editing for the markdown the AFK mutates
// (issue blocker sections, plan files, wiki pages, CONTEXT.md). A surgical edit
// replaces ONLY the bytes between two literal anchors; everything outside the
// region survives byte-for-byte. This replaces full-file model regeneration, so
// updates stop dropping or duplicating items and stop burning tokens
// regenerating whole documents. Absorbs the tasks-axi editing *technique* only —
// the backlog itself stays GitHub Issues.

/** The located span of an anchored region within a source string. */
export interface AnchoredRegion {
  /** Byte offset where the open anchor begins. */
  openStart: number;
  /** Byte offset just after the open anchor — the start of the inner content. */
  innerStart: number;
  /** Byte offset where the close anchor begins — the end of the inner content. */
  innerEnd: number;
  /** Byte offset just after the close anchor. */
  closeEnd: number;
  /** The inner content between the anchors (exclusive of the anchors themselves). */
  inner: string;
}

/**
 * Locate the first anchored region delimited by `open` and `close`. The match is
 * a literal substring search — anchors are HTML-comment markers, not patterns —
 * so a missing anchor, or a `close` that precedes the `open`, yields `null`
 * rather than a corrupting edit.
 */
export function findAnchoredRegion(
  source: string,
  open: string,
  close: string,
): AnchoredRegion | null {
  const openStart = source.indexOf(open);
  if (openStart === -1) return null;
  const innerStart = openStart + open.length;
  const innerEnd = source.indexOf(close, innerStart);
  if (innerEnd === -1) return null;
  return {
    openStart,
    innerStart,
    innerEnd,
    closeEnd: innerEnd + close.length,
    inner: source.slice(innerStart, innerEnd),
  };
}

/** Read the inner content of an anchored region, or `null` if the anchors are absent. */
export function readAnchoredRegion(source: string, open: string, close: string): string | null {
  return findAnchoredRegion(source, open, close)?.inner ?? null;
}

/**
 * Replace the inner content of an anchored region, preserving every byte outside
 * the region (and the anchors themselves) exactly. Returns the rewritten source,
 * `null` when the anchors are absent, or the unchanged source string (identical
 * reference-equal bytes) when `newInner` already matches — a no-op the caller can
 * use to skip a remote write.
 */
export function replaceAnchoredRegion(
  source: string,
  open: string,
  close: string,
  newInner: string,
): string | null {
  const region = findAnchoredRegion(source, open, close);
  if (!region) return null;
  if (region.inner === newInner) return source;
  return (
    source.slice(0, region.innerStart) + newInner + source.slice(region.innerEnd)
  );
}

/** Configuration for a no-drop / no-duplicate anchored item-list edit. */
export interface AnchoredListEdit {
  /** Literal open anchor delimiting the list region. */
  open: string;
  /** Literal close anchor delimiting the list region. */
  close: string;
  /** Identity key extracted from an item line — items with equal keys are the same item. */
  keyOf: (item: string) => string;
}

/**
 * Upsert a single item into an anchored, newline-delimited list: an item whose
 * key already exists is replaced in place, otherwise the item is appended after
 * the last existing item. All sibling items are preserved verbatim — no drop, no
 * duplicate — and blank lines bracketing the list are kept. Returns `null` when
 * the anchors are absent, or the unchanged source (byte-exact) when the upsert
 * produces no change.
 */
export function upsertAnchoredItem(
  source: string,
  edit: AnchoredListEdit,
  item: string,
): string | null {
  const region = findAnchoredRegion(source, edit.open, edit.close);
  if (!region) return null;

  // Split the inner block into leading-blank / item / trailing-blank lines so the
  // surrounding whitespace inside the region is preserved byte-for-byte.
  const lines = region.inner.split("\n");
  let lead = 0;
  while (lead < lines.length && lines[lead]!.trim().length === 0) lead += 1;
  let trail = lines.length;
  while (trail > lead && lines[trail - 1]!.trim().length === 0) trail -= 1;

  const before = lines.slice(0, lead);
  const items = lines.slice(lead, trail);
  const after = lines.slice(trail);

  const key = edit.keyOf(item);
  const idx = items.findIndex((line) => edit.keyOf(line) === key);
  if (idx === -1) {
    items.push(item);
  } else {
    items[idx] = item;
  }

  const newInner = [...before, ...items, ...after].join("\n");
  return replaceAnchoredRegion(source, edit.open, edit.close, newInner);
}
