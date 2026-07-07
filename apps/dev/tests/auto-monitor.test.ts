import { describe, expect, it } from "vitest";
import {
  decideAutoMonitorLoop,
  hasRichClaudeStatusline,
} from "../src/core/auto-monitor.js";

const REDSKILLS_STATUSLINE_SETTINGS = JSON.stringify({
  statusLine: {
    type: "command",
    command: "sh -c 'exec node \"$HOME/.cache/red-skills/bundles/dev-2.3.0.bundle.min.mjs\" statusline'",
    refreshInterval: 5,
  },
});

describe("auto monitor loop decision", () => {
  it("does not schedule the full-render cron when a rich RedSkills statusline is present", () => {
    const decision = decideAutoMonitorLoop({
      runner: "claude",
      command: "run",
      cronAvailable: true,
      richStatuslinePresent: true,
    });

    expect(decision).toEqual({
      action: "skip",
      reason: "rich-statusline-present",
    });
  });

  it("keeps the full-render cron fallback when the command-backed statusline is absent", () => {
    const decision = decideAutoMonitorLoop({
      runner: "claude",
      command: "run",
      cronAvailable: true,
      richStatuslinePresent: false,
    });

    expect(decision.action).toBe("schedule-full-render-cron");
    if (decision.action !== "schedule-full-render-cron") throw new Error("expected full-render cron");
    expect(decision.prompt).toBe("/dev:afk monitor");
    expect(decision.cron).toBe("*/10 * * * *");
  });

  it("can plan an optional lightweight reactive check without invoking the afk slash command", () => {
    const decision = decideAutoMonitorLoop({
      runner: "claude",
      command: "fleet",
      cronAvailable: true,
      richStatuslinePresent: true,
      reactiveLoopRequested: true,
    });

    expect(decision.action).toBe("schedule-reactive-check");
    if (decision.action !== "schedule-reactive-check") throw new Error("expected reactive check");
    expect(decision.prompt).toContain("red-skills-dev monitor --reactive-check");
    expect(decision.prompt).not.toContain("/dev:afk monitor");
  });
});

describe("rich Claude statusline detection", () => {
  it("recognizes the RedSkills command-backed statusline", () => {
    expect(hasRichClaudeStatusline(REDSKILLS_STATUSLINE_SETTINGS)).toBe(true);
  });

  it("does not treat an arbitrary Claude statusLine command as the AFK-rich statusline", () => {
    expect(
      hasRichClaudeStatusline(JSON.stringify({
        statusLine: {
          type: "command",
          command: "echo ok",
        },
      })),
    ).toBe(false);
  });

  it("treats missing or invalid settings as absent", () => {
    expect(hasRichClaudeStatusline("{}")).toBe(false);
    expect(hasRichClaudeStatusline("{")).toBe(false);
  });
});
