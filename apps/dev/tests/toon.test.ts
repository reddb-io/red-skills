import { describe, expect, it } from "vitest";
import { encodeToon, formatScalar } from "../src/core/toon.js";

describe("toon encoder", () => {
  it("emits scalars and nested objects as indentation key:value lines", () => {
    const out = encodeToon({
      status: "draining",
      ready: 3,
      done: false,
      note: null,
      nested: { live: 2, total: 5 },
    });
    expect(out).toBe(
      ["status: draining", "ready: 3", "done: false", "note: null", "nested:", "  live: 2", "  total: 5"].join("\n"),
    );
  });

  it("renders a uniform flat object array as ONE header row plus bare CSV rows", () => {
    const out = encodeToon({
      workers: [
        { id: "w1", runner: "claude", done: 2, total: 5 },
        { id: "w2", runner: "codex", done: 0, total: 3 },
      ],
    });
    expect(out).toBe(
      ["workers[2]{id,runner,done,total}:", "  w1,claude,2,5", "  w2,codex,0,3"].join("\n"),
    );
  });

  it("gives an empty array a definitive empty state (`key[0]:`)", () => {
    expect(encodeToon({ workers: [] })).toBe("workers[0]:");
  });

  it("inlines primitive arrays as CSV", () => {
    expect(encodeToon({ sources: ["afk", "go"] })).toBe("sources[2]: afk,go");
  });

  it("quotes cells/values that carry delimiters or look like literals", () => {
    expect(formatScalar("a,b")).toBe('"a,b"');
    expect(formatScalar("has: colon")).toBe('"has: colon"');
    expect(formatScalar("v1.2.3")).toBe("v1.2.3");
    expect(formatScalar("007")).toBe('"007"');
    expect(formatScalar("true")).toBe('"true"');
    expect(formatScalar("")).toBe('""');
    const out = encodeToon({ rows: [{ k: "x,y", n: 1 }] });
    expect(out).toBe(['rows[1]{k,n}:', '  "x,y",1'].join("\n"));
  });

  // Measured token delta vs the JSON baseline, recorded for the history
  // (PRD #928 / issue #941). TOON's win is the per-row field-name elision: a
  // uniform table of N rows names its fields once, where pretty JSON repeats
  // every key on every element. The numbers below are the live measurement.
  it("is materially smaller than pretty JSON for a tabular report (measured delta)", () => {
    const report = {
      schema_version: "red.dev.report.v1",
      generated_at: "2026-06-30T18:00:00.000Z",
      sources: [
        { origin: "afk", count: 2 },
        { origin: "go", count: 1 },
      ],
      workers: [
        { id: "w1", runner: "claude", done: 2, total: 5, blocked: 0, added: 120, removed: 14 },
        { id: "w2", runner: "codex", done: 0, total: 3, blocked: 1, added: 8, removed: 2 },
        { id: "w3", runner: "claude", done: 1, total: 4, blocked: 0, added: 51, removed: 0 },
      ],
    };
    const json = JSON.stringify(report, null, 2);
    const toon = encodeToon(report);
    // Rough token proxy: GPT-style ~4 chars/token. The char delta is the
    // measurement of record; the proxy is for the human-readable summary.
    const jsonChars = json.length;
    const toonChars = toon.length;
    const saved = jsonChars - toonChars;
    const pct = Math.round((saved / jsonChars) * 100);
    // Recorded measurement (deterministic for this fixture):
    //   JSON pretty: 682 chars (~171 tokens)
    //   TOON:        240 chars (~60 tokens)
    //   delta:       442 chars saved, ~65% smaller
    expect(jsonChars).toBe(682);
    expect(toonChars).toBe(240);
    expect(saved).toBe(442);
    expect(pct).toBeGreaterThanOrEqual(50);
  });
});
