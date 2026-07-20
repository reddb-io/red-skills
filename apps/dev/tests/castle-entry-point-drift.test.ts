import { describe, expect, it } from "vitest";
import { inspectSource } from "./support/castle-entry-point-drift.js";

describe("castle entry-point ownership drift scanner", () => {
  it.each([
    ["commands/statusline.ts", "statuslineCommand"],
    ["core/hook-dispatcher.ts", "deriveHookEnv"],
    ["platform/skill-paths.ts", "skillDirFromModule"],
  ])(
    "exempts only the named host boundary in %s",
    (path, allowedFunction) => {
      const findings = inspectSource(
        path,
        `
          export function ${allowedFunction}(worker: { ticket: number }) {
            if (worker.ticket) return "host output";
          }

          export function decideWorkerLane(worker: { lane: string }) {
            if (worker.lane) return "engine decision";
          }
        `,
      );

      expect(findings).toEqual([
        {
          path,
          line: 7,
          entities: ["Worker", "Lane"],
        },
      ]);
    },
  );

  it("detects control flow over all four engine entities", () => {
    const findings = inspectSource(
      "core/engine-owner.ts",
      `
        export function decide(worker: { ticket: number; lane: string; pr: number }) {
          if (worker.ticket && worker.lane && worker.pr) return "engine decision";
        }
      `,
    );

    expect(findings).toEqual([
      {
        path: "core/engine-owner.ts",
        line: 3,
        entities: ["Worker", "Ticket", "Lane", "PR"],
      },
    ]);
  });

  it.each(["pullRequest", "PullRequest", "pull_request"])(
    "detects the canonical PR identifier spelling %s",
    (identifier) => {
      const findings = inspectSource(
        "core/engine-owner.ts",
        `if (${identifier}.open) return "engine decision";`,
      );

      expect(findings[0]?.entities).toContain("PR");
    },
  );

  it("does not mistake adjacent orchestration vocabulary for an engine entity", () => {
    const findings = inspectSource(
      "core/host-output.ts",
      `
        if (candidate.review && validation.diff && feedback.gate) {
          return "host output";
        }
      `,
    );

    expect(findings).toEqual([]);
  });

  it.each([
    ["core/feedback.ts", "gate-executor"],
    ["core/landing.ts", "landing"],
    ["core/config.ts", "config"],
    ["commands/run/command.ts", "worker-drain"],
  ])("labels a finding in %s with the %s verb", (path, verb) => {
    expect(inspectSource(path, "if (worker.ticket) return;")[0]?.verb).toBe(verb);
  });
});
