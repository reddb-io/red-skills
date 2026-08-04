import assert from "node:assert/strict";
import test from "node:test";

import { ESC, colorEnabled, displayWidth, padEnd, padStart, stripAnsi, style, truncate } from "../src/ui/ansi.mjs";
import { ago, bytes, count, duration, oneLine, percent } from "../src/ui/format.mjs";
import { decodeKey } from "../src/ui/screen.mjs";

test("displayWidth measures the visible text, not the bytes", () => {
  assert.equal(displayWidth(style.red("abc")), 3);
  assert.equal(stripAnsi(style.bold(style.green("hi"))), "hi");
});

test("padding aligns on visible width so styled columns stay square", () => {
  assert.equal(displayWidth(padEnd(style.red("ab"), 6)), 6);
  assert.equal(displayWidth(padStart(style.red("ab"), 6)), 6);
});

test("truncate never cuts an escape sequence in half", () => {
  const cut = truncate(style.red("abcdefgh"), 5);
  assert.equal(displayWidth(cut), 5);
  if (colorEnabled) {
    assert.ok(cut.endsWith(`${ESC}[0m`), "a truncated styled cell closes its own styling");
  } else {
    assert.equal(cut, "abcd…", "a colorless terminal emits no styling to close");
  }
});

test("bytes and duration render an absence as an absence, never as zero", () => {
  assert.equal(bytes(null), "—");
  assert.equal(count(null), "—");
  assert.equal(percent(null), "—");
  assert.equal(duration(null), "—");
  assert.equal(bytes(0), "0B");
  assert.equal(bytes(1536), "1.50K");
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(3_725_000), "1h02m");
});

test("ago dates an instant against a stated now", () => {
  const now = Date.parse("2026-07-31T10:00:00.000Z");
  assert.equal(ago("2026-07-31T09:58:00.000Z", now), "2m00s ago");
  assert.equal(ago("not an instant", now), "—");
});

test("oneLine flattens a Worker's published line into one row", () => {
  assert.equal(oneLine("gate: running\n\tvitest  "), "gate: running vitest");
  assert.equal(oneLine(`${ESC}[31mred${ESC}[0m`), "red");
});

test("decodeKey names the sequences the views switch on", () => {
  assert.equal(decodeKey(Buffer.from(`${ESC}[A`)).name, "up");
  assert.equal(decodeKey(Buffer.from(`${ESC}[B`)).name, "down");
  assert.equal(decodeKey(Buffer.from(`${ESC}`)).name, "escape");
  assert.equal(decodeKey(Buffer.from("\u0003")).name, "ctrl-c");
  assert.equal(decodeKey(Buffer.from("q")).name, "q");
});
