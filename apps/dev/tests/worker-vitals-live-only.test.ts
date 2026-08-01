// `live_only: true` returned 344 dead workers and one live one, because the
// filter admitted anything carrying an alert — and every dead worker carries a
// stalled alert forever, since nothing reclaims the records. The one live
// worker (723 LOC into its review) was buried under 559KB of corpses, and the
// operator read the first record's `loc 0` as "the worker produced nothing".
import { describe, expect, it } from "vitest";
import { filterWorkerVitalsLiveOnly } from "../src/mcp-adapter.js";

const live = { live: true, active: true, alert: undefined, id: "wLIVE" };
const deadQuiet = { live: false, active: false, alert: undefined, id: "wDEAD" };
const deadStalled = { live: false, active: false, alert: { status: "stalled" }, id: "wCORPSE" };
const liveAlerted = { live: false, active: true, alert: { status: "stalling" }, id: "wSTALLING" };

describe("worker_vitals live_only", () => {
  it("drops a dead worker even when it carries a stalled alert", () => {
    const out = filterWorkerVitalsLiveOnly([live, deadStalled], true);
    expect(out.map((r) => r.id)).toEqual(["wLIVE"]);
  });

  it("keeps an ACTIVE worker whose alert is the reason to look", () => {
    const out = filterWorkerVitalsLiveOnly([liveAlerted, deadStalled], true);
    expect(out.map((r) => r.id)).toEqual(["wSTALLING"]);
  });

  it("reproduces the observed shape: 344 corpses, one live, one row out", () => {
    const corpses = Array.from({ length: 344 }, (_, i) => ({ ...deadStalled, id: `w${i}` }));
    const out = filterWorkerVitalsLiveOnly([...corpses, live], true);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("wLIVE");
  });

  it("live_only: false still returns everything", () => {
    expect(filterWorkerVitalsLiveOnly([live, deadQuiet, deadStalled], false)).toHaveLength(3);
  });
});
