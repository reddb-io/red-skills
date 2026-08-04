import { describe, expect, it } from "vitest";
import { planDrain } from "./drain.js";

describe("drain ensure planner", () => {
  it("creates an absent registration and reports every changed dimension", () => {
    expect(
      planDrain(
        {
          daemon_reachable: true,
          registration: null,
          lapsed: false,
          workers: 0,
        },
        { runner: "codex", target: 2 },
      ),
    ).toEqual({
      outcome: "apply",
      actions: [{ kind: "register", runner: "codex", target: 2 }],
      report: {
        registration: "created",
        target: "0→2",
        runner: "none→codex",
        workers_born: 2,
      },
      summary:
        "registration: created; target: 0→2; runner: none→codex; workers born: 2",
    });
  });

  it("keeps every dimension when the requested drain already stands", () => {
    expect(
      planDrain(
        {
          daemon_reachable: true,
          registration: { runner: "codex", target: 2 },
          lapsed: false,
          workers: 2,
        },
        { runner: "codex", target: 2 },
      ),
    ).toEqual({
      outcome: "apply",
      actions: [],
      report: {
        registration: "kept",
        target: "kept",
        runner: "kept",
        workers_born: "kept",
      },
      summary:
        "registration: kept; target: kept; runner: kept; workers born: kept",
    });
  });

  it("resizes a standing drain and reports the target difference", () => {
    expect(
      planDrain(
        {
          daemon_reachable: true,
          registration: { runner: "codex", target: 4 },
          lapsed: false,
          workers: 4,
        },
        { runner: "codex", target: 6 },
      ),
    ).toEqual({
      outcome: "apply",
      actions: [{ kind: "resize", runner: "codex", target: 6 }],
      report: {
        registration: "kept",
        target: "4→6",
        runner: "kept",
        workers_born: 2,
      },
      summary:
        "registration: kept; target: 4→6; runner: kept; workers born: 2",
    });
  });
});
