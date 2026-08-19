import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import brandTokens from "../../../packages/brand-tokens/tokens.json" with { type: "json" };
import { renderBoard } from "../src/ui/board.mjs";
import { renderHeader, renderWorkerRow } from "../src/ui/dashboard.mjs";
import { meter } from "../src/ui/format.mjs";
import { renderEventRow, renderLogView } from "../src/ui/logs.mjs";
import { colorEnabled, stripAnsi } from "../src/ui/ansi.mjs";
import { dashboard, snapshot, statuslinePayload } from "./fixtures.mjs";

const SOURCE_FILES = [
  "../src/commands/doctor.mjs",
  "../src/ui/ansi.mjs",
  "../src/ui/board.mjs",
  "../src/ui/dashboard.mjs",
  "../src/ui/format.mjs",
  "../src/ui/logs.mjs",
];

test("pane state uses glyphs, neutral intensity, and the red spotlight only", async () => {
  for (const relative of SOURCE_FILES) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.doesNotMatch(source, /style\.(?:green|yellow|cyan|magenta|brightGreen|brightYellow|brightCyan|brightMagenta)\b/);
    assert.doesNotMatch(source, /(?:38|48);2;/, "truecolor must be derived by the brand package");
  }
});

test("plain pane output preserves every state distinction formerly carried by colour", () => {
  const fresh = snapshot();
  const stale = snapshot();
  stale.payload.staleness = { ...stale.payload.staleness, stale: true, reason: "sample expired" };
  assert.match(stripAnsi(renderHeader(fresh, { columns: 120, now: fresh.readAt })[0]), /● live$/);
  assert.match(stripAnsi(renderHeader(stale, { columns: 120, now: stale.readAt })[0]), /▲ stale$/);

  const workers = statuslinePayload().workers;
  assert.match(stripAnsi(renderWorkerRow(workers[0], { columns: 120, selected: false, verbose: false })[0]), /▶ running/);
  assert.match(stripAnsi(renderWorkerRow({ ...workers[0], state: "reattached" }, { columns: 120, selected: false, verbose: false })[0]), /↪ reattached/);

  const event = (kind) => stripAnsi(renderEventRow({ event: kind, worker_id: "w", project_label: "p" }, { columns: 120 }));
  assert.match(event("worker-birth"), /\+ birth/);
  assert.match(event("worker-death"), /† death/);
  assert.match(event("worker-budget-kill"), /! budget-kill/);

  assert.equal(stripAnsi(meter(0.5, 6)), "███░░░");
  assert.equal(stripAnsi(meter(0.75, 6)), "████▲░");
  assert.equal(stripAnsi(meter(0.95, 6)), "█████!");
});

test("identity moments resolve brand.primary through the tokens package", () => {
  if (!colorEnabled) return;
  const [red, green, blue] = brandTokens.color.brand.primary.$value
    .replace(/^\{|\}$/g, "")
    .split(".")
    .reduce((node, part) => node[part], brandTokens).$value.components
    .map((component) => Math.round(component * 255));
  const brand = `\u001b[38;2;${red};${green};${blue}m`;
  const snap = snapshot();
  assert.ok(renderHeader(snap, { columns: 120, now: snap.readAt })[0].includes(`${brand}redskilled`));
  assert.ok(renderBoard({ dashboard: dashboard(), state: { mode: "global", message: null }, size: { columns: 160, rows: 30 } })[0].includes(brand));
  assert.ok(renderLogView({ title: "events", subtitle: "host", lines: [], offset: 0, follow: true, size: { columns: 80, rows: 10 }, empty: "none" })[0].includes(`${brand}red-skills`));
});
