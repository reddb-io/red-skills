import { describe, expect, it } from "vitest";
import {
  renderStatusline,
  type ClaudeInput,
  type RepoInput,
  type StatuslineInput,
} from "../src/core/statusline.js";
import type { CompactWorker } from "../src/core/monitor.js";
import {
  renderHeaderLine,
  renderStatuslineThemed,
  renderWorkerLine,
  styleStatusline,
} from "../src/core/statusline-style.js";

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const WINE = "\x1b[48;2;114;47;55m";
const WINE2 = "\x1b[48;2;88;36;42m";
const NOBG = "\x1b[49m";
const SOFT = "\x1b[38;2;224;138;148m";
const RESET = "\x1b[0m";

const NOW = 1_000_000; // fixed epoch seconds so worker elapsed clocks are deterministic

/** A live worker fixture: on #17, 5 minutes elapsed, +12 -3 diff. */
function worker(over: Partial<CompactWorker> = {}): CompactWorker {
  return {
    state: {
      worker_id: "w1",
      pid: 4242,
      runner: "claude",
      started_at: new Date((NOW - 300) * 1000).toISOString(),
      total: 10,
      done: 7,
      blocked: 0,
      failed: 0,
      current: {
        number: 17,
        title: "redesign statusline",
        stage: "impl",
        started_at: new Date((NOW - 300) * 1000).toISOString(),
      },
    },
    live: true,
    pidLive: true,
    diffAdded: 12,
    diffRemoved: 3,
    ...over,
  };
}

const claude: ClaudeInput = {
  model: "Opus",
  effort: "high",
  contextTokens: 47000,
  contextPercent: 24,
  usage5h: 23,
  usage7d: 41,
};
const repo: RepoInput = { openPrs: 3, openIssues: 24, localAdded: 142, localRemoved: 36 };
const input: StatuslineInput = {
  project: { basename: "red-skills", branch: "main", version: "1.2.3" },
  claude,
  repo,
};

describe("statusline style — header line", () => {
  it("powerlines » project, model·effort, ctx, 5h/7d usage, prs/iss, +local/-local — reset-terminated", () => {
    const h = renderHeaderLine(input.project, claude, repo);
    expect(h).not.toContain("\n");
    expect(h.endsWith(RESET)).toBe(true);
    expect(h).toContain(WINE2); // project block bg
    expect(h).toContain(WINE); // model block bg
    expect(h).toContain(NOBG); // background drops to transparent after the model
    const t = stripAnsi(h);
    expect(t).toContain("» red-skills (main)");
    expect(t).toContain("v1.2.3");
    expect(t).toContain("Opus·high");
    expect(t).toContain("ctx=47k 24%");
    expect(t).toContain("5h=23%");
    expect(t).toContain("7d=41%");
    expect(t).toContain("prs=3");
    expect(t).toContain("iss=24");
    expect(t).toContain("loc=+142 -36");
  });

  it("renders only the usage window that is present (graceful absence)", () => {
    const t = stripAnsi(renderHeaderLine(input.project, { ...claude, usage7d: undefined }, repo));
    expect(t).toContain("5h=23%");
    expect(t).not.toContain("7d=");
  });

  it("drops the usage tokens entirely for a non-Pro/Max session", () => {
    const t = stripAnsi(
      renderHeaderLine(input.project, { ...claude, usage5h: undefined, usage7d: undefined }, repo),
    );
    expect(t).not.toContain("5h=");
    expect(t).not.toContain("7d=");
    expect(t).toContain("ctx=47k 24%"); // rest of the header intact
  });

  it("prs= carries a compact age suffix when repo cacheAgeS is set (stale cache)", () => {
    const t = stripAnsi(renderHeaderLine(input.project, claude, { ...repo, cacheAgeS: 720 }));
    expect(t).toContain("prs=3 (12m)");
    expect(t).toContain("iss=24");
    expect(t.match(/\(12m\)/g)?.length ?? 0).toBe(1);
  });

  it("age suffix moves to iss= when openPrs is 0 and repo cache is stale", () => {
    const t = stripAnsi(
      renderHeaderLine(input.project, claude, { ...repo, openPrs: 0, cacheAgeS: 720 }),
    );
    expect(t).not.toContain("prs=");
    expect(t).toContain("iss=24 (12m)");
  });

  it("drops the repo blocks when counts are zero / a clean branch", () => {
    const t = stripAnsi(
      renderHeaderLine(input.project, claude, {
        openPrs: 0,
        openIssues: 0,
        localAdded: 0,
        localRemoved: 0,
      }),
    );
    expect(t).not.toContain("prs=");
    expect(t).not.toContain("iss=");
    expect(t).not.toContain("loc=");
  });

  it("drops model/ctx/usage/repo outside Claude Code with no repo stats", () => {
    const h = renderHeaderLine({ basename: "c3" }, undefined, undefined);
    expect(stripAnsi(h)).toBe(" » c3 ");
    expect(h).not.toContain(WINE);
  });
});

describe("statusline style — per-worker line", () => {
  it("reuses the monitor's compact formatter, tinted and reset-terminated", () => {
    const line = renderWorkerLine(worker(), NOW);
    expect(line.endsWith(RESET)).toBe(true);
    expect(line).toContain(NOBG); // fully transparent — no red block
    expect(line).toContain(SOFT); // soft-red tint
    expect(line).not.toContain(WINE); // never a wine background on a worker line
    const t = stripAnsi(line);
    expect(t).toContain("w1 [live] claude"); // wID + liveness badge + runner
    expect(t).toContain("issues 7/10"); // progress counter
    expect(t).toContain("#17 redesign statusline"); // issue + title
    expect(t).toContain("stage:impl"); // stage
    expect(t).toContain("00:05:00"); // elapsed
    expect(t).toContain("+12 -3"); // diff volume
  });

  it("shows per-worker token spend when the runner streamed usage", () => {
    const w = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, input_tokens: 1200, output_tokens: 400 },
      },
    });
    expect(stripAnsi(renderWorkerLine(w, NOW))).toContain("tok:1200/400");
  });
});

describe("statusline style — full themed assembly", () => {
  it("emits the header row plus one row per live worker, each reset-terminated", () => {
    const out = styleStatusline(input, { workers: [worker(), worker({ state: { ...worker().state, worker_id: "w2", current: { ...worker().state.current, number: 20 } } })], now: NOW });
    const rows = out.split("\n");
    expect(rows).toHaveLength(3); // header + two workers
    expect(rows[0].endsWith(RESET)).toBe(true);
    expect(rows[1].endsWith(RESET)).toBe(true);
    expect(rows[2].endsWith(RESET)).toBe(true);
    expect(stripAnsi(rows[0])).toContain("» red-skills");
    expect(stripAnsi(rows[0])).toContain("prs=3");
    expect(stripAnsi(rows[1])).toContain("w1 [live]");
    expect(stripAnsi(rows[2])).toContain("#20");
  });

  it("emits only the header row when there are no live workers", () => {
    const out = styleStatusline(input, { workers: [], now: NOW });
    expect(out).not.toContain("\n");
    expect(stripAnsi(out)).toContain("Opus·high");
    expect(stripAnsi(out)).toContain("prs=3");
  });

  it("defaults to the header row alone when no workers/now are supplied", () => {
    const out = styleStatusline(input);
    expect(out).not.toContain("\n");
    expect(stripAnsi(out)).toContain("» red-skills");
  });

  it("renderStatuslineThemed switches between multi-line themed and plain on the color flag", () => {
    const opts = { workers: [worker()], now: NOW };
    expect(renderStatuslineThemed(input, true, opts)).toBe(styleStatusline(input, opts));
    expect(renderStatuslineThemed(input, false, opts)).toBe(renderStatusline(input));
    expect(renderStatuslineThemed(input, false, opts)).not.toContain("\x1b");
    expect(renderStatuslineThemed(input, false, opts)).not.toContain("\n"); // plain form is single-line
  });
});
