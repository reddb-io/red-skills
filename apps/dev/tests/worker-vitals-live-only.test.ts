// `live_only: true` returned 344 dead workers and one live one, because the
// filter admitted anything carrying an alert — and every dead worker carries a
// stalled alert forever, since nothing reclaims the records (#2978). The one
// live worker (723 LOC into its review) was buried under 559KB of corpses.
// The legitimate case the alert arm was written for survives: a worker that
// dies at boot must surface on the very next default read, or a fast death is
// invisible — so a FRESH alert passes and an aged one does not.
import { describe, expect, it } from "vitest";
import { filterWorkerVitalsLiveOnly, WORKER_VITALS_ALERT_FRESH_MS } from "../src/mcp-adapter.js";

const NOW = Date.parse("2026-08-01T03:00:00.000Z");
const fresh = new Date(NOW - 60_000).toISOString();
const aged = new Date(NOW - WORKER_VITALS_ALERT_FRESH_MS - 60_000).toISOString();

const live = { live: true, alert: undefined, id: "wLIVE" };
const deadQuiet = { live: false, alert: undefined, id: "wDEAD" };
const freshDeath = { live: false, alert: { at: fresh }, id: "wBOOTDEATH" };
const corpse = { live: false, alert: { at: aged }, id: "wCORPSE" };

describe("worker_vitals live_only", () => {
  it("surfaces a fresh death — the page a boot error is", () => {
    const out = filterWorkerVitalsLiveOnly([live, freshDeath], true, NOW);
    expect(out.map((r) => r.id)).toEqual(["wLIVE", "wBOOTDEATH"]);
  });

  it("drops an aged corpse even though it still carries its alert", () => {
    const out = filterWorkerVitalsLiveOnly([live, corpse], true, NOW);
    expect(out.map((r) => r.id)).toEqual(["wLIVE"]);
  });

  it("reproduces the observed shape: 344 aged corpses in, one live row out", () => {
    const corpses = Array.from({ length: 344 }, (_, i) => ({ ...corpse, id: `w${i}` }));
    const out = filterWorkerVitalsLiveOnly([...corpses, live], true, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("wLIVE");
  });

  it("live_only: false still returns everything, however old", () => {
    expect(filterWorkerVitalsLiveOnly([live, deadQuiet, corpse], false, NOW)).toHaveLength(3);
  });
});
