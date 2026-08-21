import { describe, expect, it } from "vitest";

import { progressBar } from "../dashboard.js";
import {
  REDSKILLED_MACRO_PHASES,
  REDSKILLED_PHASE_MACRO_TABLE,
  resolveLifecyclePosition,
} from "../lifecycle-phase.js";
import { REDSKILLED_RENDER_DISPLAY_ABSENT } from "../payload.js";
import { phaseActivityCell } from "../worker-cells.js";

/** The stages `@reddb-io/worker` pulses, restated so a drift here is visible. */
const TICKET_LOOP_STAGES = ["claim", "implement", "gate", "publish", "land"] as const;

const display = (fields: Record<string, unknown>) => ({
  ...REDSKILLED_RENDER_DISPLAY_ABSENT,
  ...fields,
});

describe("resolveLifecyclePosition", () => {
  it("gives every ticket-loop stage a declared cell", () => {
    for (const stage of TICKET_LOOP_STAGES) {
      const position = resolveLifecyclePosition(stage);
      expect(position, `stage ${stage} has no declared macro phase`).not.toBeNull();
      expect(REDSKILLED_MACRO_PHASES).toContain(position!.macro);
      expect(position!.total).toBe(REDSKILLED_MACRO_PHASES.length);
    }
  });

  it("walks the pipeline forward, and folds publish and land onto one cell", () => {
    expect(resolveLifecyclePosition("claim")?.index).toBe(0);
    expect(resolveLifecyclePosition("implement")?.index).toBe(1);
    expect(resolveLifecyclePosition("gate")?.index).toBe(2);
    expect(resolveLifecyclePosition("publish")?.index).toBe(3);
    expect(resolveLifecyclePosition("land")?.index).toBe(3);
  });

  it("reads the stage's own refusal mark as the cursor's failure, keeping its place", () => {
    expect(resolveLifecyclePosition("gate!")).toEqual({
      macro: "validating",
      index: 2,
      total: 5,
      failed: true,
    });
  });

  it("resolves nothing for an absent, empty or undeclared word", () => {
    expect(resolveLifecyclePosition(null)).toBeNull();
    expect(resolveLifecyclePosition("")).toBeNull();
    expect(resolveLifecyclePosition("   ")).toBeNull();
    expect(resolveLifecyclePosition("reticulating-splines")).toBeNull();
  });

  it("declares every macro phase as its own row, so a project publishing one passes through", () => {
    for (const macro of REDSKILLED_MACRO_PHASES) {
      expect(REDSKILLED_PHASE_MACRO_TABLE[macro]).toBe(macro);
    }
  });
});

describe("progressBar", () => {
  it("draws a bar for a live Worker that publishes only a stage", () => {
    expect(progressBar(display({ phase: "claim" }))).toBe("▶░░░░");
    expect(progressBar(display({ phase: "implement" }))).toBe("█▶░░░");
    expect(progressBar(display({ phase: "gate" }))).toBe("██▶░░");
    expect(progressBar(display({ phase: "land" }))).toBe("███▶░");
  });

  it("fills the whole bar when the work is done", () => {
    expect(progressBar(display({ phase: "done" }))).toBe("█████");
  });

  it("spends the failure cursor on a stage that refused", () => {
    expect(progressBar(display({ phase: "gate!" }))).toBe("██✗░░");
  });

  it("draws NO bar rather than a bar of unknown position", () => {
    expect(progressBar(display({ phase: null }))).toBe("");
    expect(progressBar(display({ phase: "sharpening-pencils" }))).toBe("");
  });

  it("lets a project's own published position win over the declared table", () => {
    // `claim` would resolve to cell 0; the published pair says otherwise and owns
    // a pipeline this renderer does not.
    expect(progressBar(display({ phase: "claim", phase_index: 2, phase_total: 3 }))).toBe("██▶");
  });
});

describe("phaseActivityCell", () => {
  it("positions the phase from the same resolution the bar uses", () => {
    expect(phaseActivityCell(display({ phase: "gate", step: "round 2" }))).toBe("gate 3/5 · round 2");
  });

  it("leaves an undeclared phase its bare word and no invented ordinal", () => {
    expect(phaseActivityCell(display({ phase: "napping" }))).toBe("napping");
  });
});
