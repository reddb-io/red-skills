import { describe, expect, it } from "vitest";

import { runWorkerLocalGate } from "./local-gate.js";
import { ticketHandoffFromMeta } from "@reddb-io/protocol-acp";

/**
 * The declared schedule is the sole local validation authority (#4166): a
 * Worker handed `validation_commands` runs exactly those and never improvises
 * the package-cone suite, which contradicted the declaration and flaked under
 * the Worker memory ceiling — a different package red each round.
 */
describe("the Worker gate runs the declared commands", () => {
  it("runs them in order as the feedback stage and stops at the first failure", async () => {
    const ran: string[] = [];
    const result = await runWorkerLocalGate({
      worktree: "/tmp/wt",
      base: "main",
      validationCommands: ["pnpm typecheck", "pnpm -C apps/plugin-dev test:invariants", "never-reached"],
      backpressureExec: async ({ command }) => {
        ran.push(command);
        return command === "pnpm -C apps/plugin-dev test:invariants"
          ? { code: 1, stdout: "", stderr: "invariant broke: lane unregistered" }
          : { code: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(ran).toEqual(["pnpm typecheck", "pnpm -C apps/plugin-dev test:invariants"]);
    expect(result.stages.find((stage) => stage.stage === "feedback")?.ok).toBe(false);
    expect(result.detail).toContain("invariant broke: lane unregistered");
  });

  it("passes clean and still runs backpressure afterwards", async () => {
    const ran: string[] = [];
    const result = await runWorkerLocalGate({
      worktree: "/tmp/wt",
      base: "main",
      validationCommands: ["pnpm typecheck"],
      backpressureCommands: ["pnpm extra"],
      backpressureExec: async ({ command }) => {
        ran.push(command);
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    expect(ran).toEqual(["pnpm typecheck", "pnpm extra"]);
    expect(result.stages.find((stage) => stage.stage === "feedback")?.ok).toBe(true);
    expect(result.stages.find((stage) => stage.stage === "backpressure")?.ok).toBe(true);
    expect(result.sidecar.length).toBe(2);
  });
});

describe("the ticket wire carries the declared commands", () => {
  it("round-trips validation_commands and drops a malformed list", () => {
    const base = {
      number: 7, title: "t", labels: [], base: "main", handoff: "h", worker_id: "W1",
    };
    expect(ticketHandoffFromMeta({
      redskills: { ticket: { ...base, validation_commands: ["pnpm typecheck"] } },
    })?.validation_commands).toEqual(["pnpm typecheck"]);
    expect(ticketHandoffFromMeta({
      redskills: { ticket: { ...base, validation_commands: [7] } },
    })?.validation_commands).toBeUndefined();
  });
});
