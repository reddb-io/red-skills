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
});
