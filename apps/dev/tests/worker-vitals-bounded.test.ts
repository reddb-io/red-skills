// worker_vitals answers a BOUNDED payload, live rows first (#2978).
//
// The reclaim keeps the record lane small; this keeps the payload small while a
// pile exists at all — the window between a Worker dying and the retention
// releasing its record, and every `live_only: false` read that deliberately asks
// for the dead ones. The bound is pinned here because the number is the
// contract: an unbounded read serialised 559KB across 18,633 lines to convey one
// live row, and the corpse it put FIRST read as "the worker produced nothing".

import { describe, expect, it } from "vitest";
import { boundWorkerVitals, WORKER_VITALS_MAX_RECORDS } from "../src/mcp-adapter.js";

const NOW = Date.parse("2026-08-01T03:00:00.000Z");

function record(over: {
  id: string;
  live?: boolean;
  lastEventAtMs?: number;
  startedAtMs?: number;
}) {
  return {
    id: over.id,
    live: over.live ?? false,
    worker: {
      started_at: new Date(over.startedAtMs ?? 0).toISOString(),
      current: {
        last_event_at:
          over.lastEventAtMs === undefined ? "" : new Date(over.lastEventAtMs).toISOString(),
      },
    },
  };
}

describe("the worker_vitals payload bound", () => {
  it("pins the bound at 32 rows", () => {
    expect(WORKER_VITALS_MAX_RECORDS).toBe(32);
  });

  it("caps the answer at the bound, whatever the pile size", () => {
    const pile = Array.from({ length: 345 }, (_, i) =>
      record({ id: `w${i}`, lastEventAtMs: NOW - i * 1_000 }),
    );
    expect(boundWorkerVitals(pile)).toHaveLength(WORKER_VITALS_MAX_RECORDS);
  });

  it("leaves an answer already inside the bound untouched, in order", () => {
    const few = [record({ id: "wA" }), record({ id: "wB", live: true }), record({ id: "wC" })];
    expect(boundWorkerVitals(few).map((r) => r.id)).toEqual(["wA", "wB", "wC"]);
  });

  it("puts the live row FIRST when the pile would otherwise bury it", () => {
    // The observed shape: the live worker arrives last, behind 344 corpses whose
    // events are all more recent than its start.
    const corpses = Array.from({ length: 344 }, (_, i) =>
      record({ id: `w${i}`, lastEventAtMs: NOW - i * 1_000 }),
    );
    const live = record({ id: "wLIVE", live: true, lastEventAtMs: NOW - 10_000_000 });
    const out = boundWorkerVitals([...corpses, live]);
    expect(out[0]!.id).toBe("wLIVE");
    expect(out).toHaveLength(WORKER_VITALS_MAX_RECORDS);
  });

  it("never drops a live row: a fleet at the bound is returned whole", () => {
    const fleet = Array.from({ length: WORKER_VITALS_MAX_RECORDS }, (_, i) =>
      record({ id: `wL${i}`, live: true, lastEventAtMs: NOW - i }),
    );
    const corpses = Array.from({ length: 300 }, (_, i) =>
      record({ id: `wD${i}`, lastEventAtMs: NOW }),
    );
    const out = boundWorkerVitals([...corpses, ...fleet]);
    expect(out.every((r) => r.live)).toBe(true);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(fleet.map((r) => r.id)));
  });

  it("drops the OLDEST dead rows first — the ones the lane log still carries", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      record({ id: `w${i}`, lastEventAtMs: NOW - i * 60_000 }),
    );
    const out = boundWorkerVitals(rows);
    expect(out.map((r) => r.id)).toEqual(
      rows.slice(0, WORKER_VITALS_MAX_RECORDS).map((r) => r.id),
    );
  });

  it("falls back to started_at when a row records no last event", () => {
    const rows = [
      ...Array.from({ length: 32 }, (_, i) => record({ id: `w${i}`, startedAtMs: NOW - 1_000 })),
      record({ id: "wNEWEST", startedAtMs: NOW }),
    ];
    expect(boundWorkerVitals(rows)[0]!.id).toBe("wNEWEST");
  });

  it("keeps the payload small: the bound holds the serialised size in kilobytes, not hundreds", () => {
    const pile = Array.from({ length: 345 }, (_, i) =>
      record({ id: `w${i}`, lastEventAtMs: NOW - i * 1_000 }),
    );
    const bounded = JSON.stringify(boundWorkerVitals(pile)).length;
    expect(bounded).toBeLessThan(JSON.stringify(pile).length / 10);
  });
});
