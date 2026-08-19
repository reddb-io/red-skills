import { describe, expect, it } from "vitest";
import {
  findAnchoredRegion,
  readAnchoredRegion,
  replaceAnchoredRegion,
  upsertAnchoredItem,
} from "../src/core/anchored-edit.js";

const OPEN = "<!-- begin -->";
const CLOSE = "<!-- end -->";

describe("findAnchoredRegion", () => {
  it("locates the inner span between anchors", () => {
    const src = `head\n${OPEN}\nbody\n${CLOSE}\ntail`;
    const region = findAnchoredRegion(src, OPEN, CLOSE);
    expect(region).not.toBeNull();
    expect(src.slice(region!.openStart, region!.innerStart)).toBe(OPEN);
    expect(src.slice(region!.innerEnd, region!.closeEnd)).toBe(CLOSE);
    expect(region!.inner).toBe("\nbody\n");
  });

  it("returns null when an anchor is missing", () => {
    expect(findAnchoredRegion("no anchors here", OPEN, CLOSE)).toBeNull();
    expect(findAnchoredRegion(`${OPEN} only open`, OPEN, CLOSE)).toBeNull();
  });

  it("returns null when the close precedes the open", () => {
    expect(findAnchoredRegion(`${CLOSE} ... ${OPEN}`, OPEN, CLOSE)).toBeNull();
  });
});

describe("replaceAnchoredRegion", () => {
  it("applies the edit without regenerating the surrounding bytes", () => {
    const src = `# Title\n\nintro paragraph\n\n${OPEN}old inner${CLOSE}\n\noutro paragraph\n`;
    const out = replaceAnchoredRegion(src, OPEN, CLOSE, "new inner");
    expect(out).not.toBeNull();
    // surrounding content is byte-for-byte identical
    const head = src.slice(0, src.indexOf(OPEN));
    const tail = src.slice(src.indexOf(CLOSE) + CLOSE.length);
    expect(out!.startsWith(head)).toBe(true);
    expect(out!.endsWith(tail)).toBe(true);
    expect(out).toBe(`# Title\n\nintro paragraph\n\n${OPEN}new inner${CLOSE}\n\noutro paragraph\n`);
  });

  it("round-trips: reading back what was written returns the exact inner", () => {
    const src = `a\n${OPEN}original${CLOSE}\nb`;
    const out = replaceAnchoredRegion(src, OPEN, CLOSE, "\nmulti\nline\n");
    expect(readAnchoredRegion(out!, OPEN, CLOSE)).toBe("\nmulti\nline\n");
  });

  it("is a no-op (identical bytes) when the new inner equals the old", () => {
    const src = `x${OPEN}same${CLOSE}y`;
    expect(replaceAnchoredRegion(src, OPEN, CLOSE, "same")).toBe(src);
  });

  it("returns null when anchors are absent rather than corrupting the file", () => {
    expect(replaceAnchoredRegion("plain text", OPEN, CLOSE, "x")).toBeNull();
  });
});

describe("upsertAnchoredItem — no-drop / no-duplicate on a multi-item document", () => {
  const keyOf = (line: string) => line.split("|", 1)[0]!.trim();
  const doc = [
    "preamble line",
    "",
    OPEN,
    "alpha | first",
    "bravo | second",
    "charlie | third",
    CLOSE,
    "",
    "trailing line",
  ].join("\n");

  it("updates an existing item in place without dropping or duplicating siblings", () => {
    const out = upsertAnchoredItem(doc, { open: OPEN, close: CLOSE, keyOf }, "bravo | UPDATED");
    expect(out).not.toBeNull();
    const inner = readAnchoredRegion(out!, OPEN, CLOSE)!;
    const items = inner.split("\n").filter((l) => l.trim().length > 0);
    expect(items).toEqual(["alpha | first", "bravo | UPDATED", "charlie | third"]);
    // exactly one bravo — no duplicate
    expect(items.filter((l) => keyOf(l) === "bravo")).toHaveLength(1);
    // surrounding content untouched byte-for-byte
    expect(out!.startsWith("preamble line\n\n")).toBe(true);
    expect(out!.endsWith("\n\ntrailing line")).toBe(true);
  });

  it("appends a new item without disturbing existing ones", () => {
    const out = upsertAnchoredItem(doc, { open: OPEN, close: CLOSE, keyOf }, "delta | fourth");
    const inner = readAnchoredRegion(out!, OPEN, CLOSE)!;
    const items = inner.split("\n").filter((l) => l.trim().length > 0);
    expect(items).toEqual(["alpha | first", "bravo | second", "charlie | third", "delta | fourth"]);
  });

  it("is a byte-exact no-op when upserting an item identical to the current one", () => {
    const out = upsertAnchoredItem(doc, { open: OPEN, close: CLOSE, keyOf }, "bravo | second");
    expect(out).toBe(doc);
  });
});
