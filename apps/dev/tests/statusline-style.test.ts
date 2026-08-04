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
const KEY = "\x1b[38;2;255;214;214m";
const DIM = "\x1b[38;2;201;150;158m";
const GREEN = "\x1b[38;2;96;214;128m";
const RED = "\x1b[38;2;255;95;95m";
const YELLOW = "\x1b[38;2;240;200;120m";
const BAR_DONE = "\x1b[38;2;240;110;120m";
const BAR_CURRENT = "\x1b[38;2;255;214;214m";
const BAR_AHEAD = "\x1b[38;2;146;84;94m";
const BOLD = "\x1b[1m";
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
        activity: "impl",
        model: "claude-opus-4-8",
        effort: "high",
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
  docs: { count: 2 },
};

describe("statusline style — header line", () => {
  it("powerlines » project, model·effort, ctx, 5h/7d usage, prs/iss, +local/-local — reset-terminated", () => {
    const h = renderHeaderLine(input.project, claude, repo, undefined, "full", undefined, input.docs);
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
    expect(t).toContain("doc=2");
  });

  it("renders only the usage window that is present (graceful absence)", () => {
    const t = stripAnsi(renderHeaderLine(input.project, { ...claude, usage7d: undefined }, repo));
    expect(t).toContain("5h=23%");
    expect(t).not.toContain("7d=");
  });

  it("stars the themed session version when a newer cached bundle is available", () => {
    const t = stripAnsi(renderHeaderLine({
      basename: "red-skills",
      branch: "main",
      version: "1.2.3",
      latestCachedVersion: "1.2.4",
    }, claude, repo));
    expect(t).toContain("v1.2.3*");
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

  it("short preset keeps only project identity, ctx, and iss", () => {
    const h = renderHeaderLine(input.project, claude, repo, undefined, "short");
    const t = stripAnsi(h);
    expect(t).toContain("» red-skills (main)");
    expect(t).toContain("ctx=47k 24%");
    expect(t).toContain("iss=24");
    expect(t).not.toContain("v1.2.3");
    expect(t).not.toContain("Opus·high");
    expect(t).not.toContain("5h=");
    expect(t).not.toContain("7d=");
    expect(t).not.toContain("prs=");
    expect(t).not.toContain("loc=+142 -36");
    expect(t).not.toContain("doc=");
  });

  it("styles rsp states from the shared render model", () => {
    const healthy = renderHeaderLine(input.project, claude, repo, undefined, "full", {
      state: "ready",
      tokensSavedToday: 1320000,
      dollarsSavedTodayUsd: 1.625,
    });
    expect(healthy).toContain(`${GREEN}rsp=↓1.32M${SOFT}`);
    expect(stripAnsi(healthy)).toContain("rsp=↓1.32M");
    expect(stripAnsi(healthy)).not.toContain("$1.63");

    const warming = renderHeaderLine(input.project, claude, repo, undefined, "full", { state: "warming" });
    expect(warming).toContain(`${DIM}rsp=…${SOFT}`);
    expect(stripAnsi(warming)).toContain("rsp=…");

    const error = renderHeaderLine(input.project, claude, repo, undefined, "full", { state: "error" });
    expect(error).toContain(`${RED}rsp=!${SOFT}`);
    expect(stripAnsi(error)).toContain("rsp=!");
  });
});

describe("statusline style — terse per-worker line (issue #1175)", () => {
  it.each([
    ["setup", "▶░░░░"],
    ["coding", "█▶░░░"],
    ["validating", "██▶░░"],
    ["merging", "███▶░"],
    ["done", "█████"],
  ])("renders the five-cell lifecycle bar for the %s macro phase", (phase, expected) => {
    const w = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, phase },
      },
    });

    expect(stripAnsi(renderWorkerLine(w, NOW)).match(/[█▶░]{5}/)?.[0]).toBe(expected);
  });

  it("falls back to setup for an unknown legacy phase without throwing", () => {
    const w = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, phase: "legacy-phase" },
      },
    });

    expect(stripAnsi(renderWorkerLine(w, NOW)).match(/[█▶░]{5}/)?.[0]).toBe("▶░░░░");
  });

  it("colors completed, current, and future lifecycle cells along the wine ramp", () => {
    const validating = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, phase: "validating" },
      },
    });
    const done = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, phase: "done" },
      },
    });

    expect(renderWorkerLine(validating, NOW)).toContain(`${BAR_DONE}██${BAR_CURRENT}▶${BAR_AHEAD}░░${SOFT}`);
    expect(renderWorkerLine(done, NOW)).toContain(`${BAR_DONE}█████${SOFT}`);
  });

  it.each([
    ["parked", { blocked: 1, failed: 0 }],
    ["failed", { blocked: 0, failed: 1 }],
  ])("colors the current lifecycle cell red for a %s worker", (_state, counts) => {
    const w = worker({
      state: {
        ...worker().state,
        ...counts,
        current: { ...worker().state.current, phase: "validating" },
      },
    });

    expect(renderWorkerLine(w, NOW)).toContain(`${BAR_DONE}██${RED}▶${BAR_AHEAD}░░${SOFT}`);
  });

  it("renders the terse colored k=v line: bold-red wID, k=v tokens, iss=number, bare stage, elapsed, loc, tks, individual vitals", () => {
    const line = renderWorkerLine(worker(), NOW);
    expect(line.endsWith(RESET)).toBe(true);
    expect(line).toContain(NOBG); // fully transparent — no red block
    expect(line).toContain(SOFT); // soft-red tint
    expect(line).toContain(KEY); // k=v keys reuse line 1's light-red KEY colour
    expect(line).toContain(BOLD); // wID is bold
    expect(line).not.toContain(WINE); // never a wine background on a worker line
    // wID renders bold, immediately (bold red).
    expect(line.startsWith(`${NOBG}${SOFT}${BOLD}w1`)).toBe(true);
    const t = stripAnsi(line);
    // The terse spec, token by token (issue #1176 fixes).
    expect(t).toContain("w1"); // bare wID (no [live]/[quiet] badge)
    expect(t).toContain("run=claude opus-4.8 high"); // runner + shortened model + effort
    expect(t).toContain("iss=17"); // the ISSUE NUMBER (current.number), not a done/total counter
    expect(t).toContain("impl"); // bare stage (no activity: prefix, no #<n>)
    expect(t).toContain("00:05:00"); // elapsed REQUIRED
    expect(t).toContain("hb=?"); // legacy fixtures without an evaluator verdict stay explicit
    expect(t).toContain("loc=+12 -3"); // diff as loc= k=v
    expect(t).toContain("tks=—"); // claude has no live usage stream yet
    expect(t).toContain("tls=0 rsn=0 txt=0"); // vitals as individual 3-letter k=v pairs
    // The DROPPED verbosity must be gone.
    expect(t).not.toContain("iss=7/10"); // the old done/total counter is gone
    expect(t).not.toContain("#17"); // the standalone #<n> token is dropped
    expect(t).not.toContain("tools="); // unified as tls=
    expect(t).not.toContain("reason="); // unified as rsn=
    expect(t).not.toContain("text="); // unified as txt=
    expect(t).not.toContain("[live]");
    expect(t).not.toContain("[quiet]");
    expect(t).not.toContain("redesign statusline"); // no title
    expect(t).not.toContain("activity:"); // no activity: prefix
    expect(t).not.toContain("wait"); // no wait token
    expect(t).not.toMatch(/\blog:/); // no log token
    expect(t).not.toContain("stats="); // vitals are not a nested blob
  });

  it("keeps legacy k=v keys at 3 letters and the canonical proof-of-life key as hb (#1176, #2480)", () => {
    const t = stripAnsi(renderWorkerLine(worker(), NOW));
    // Collect every key that precedes an `=` and assert each is 3 chars.
    const keys = [...t.matchAll(/([A-Za-z]+)=/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      if (key === "hb") expect(key).toHaveLength(2);
      else expect(key).toHaveLength(3);
    }
    // The concrete set present.
    expect(keys).toEqual(expect.arrayContaining(["run", "iss", "hb", "loc", "tks", "tls", "rsn", "txt"]));
  });

  it("renders evaluator lane age and makes active, quiet-with-descendant, and wedged workers distinct (#2480)", () => {
    const active = worker({
      livenessVerdict: {
        status: "alive",
        laneFresh: true,
        laneAgeMs: 3_000,
        crossCheckArmed: true,
        reason: "lane fresh",
      },
    });
    const quiet = worker({
      livenessVerdict: {
        status: "alive",
        laneFresh: false,
        laneAgeMs: 11 * 60_000,
        crossCheckArmed: true,
        liveDescendants: true,
        reason: "lane idle but live descendants",
      },
    });
    const wedged = worker({
      live: false,
      livenessVerdict: {
        status: "stalled",
        laneFresh: false,
        laneAgeMs: 11 * 60_000,
        crossCheckArmed: true,
        liveDescendants: false,
        reason: "lane idle and no live descendants",
      },
    });

    expect(stripAnsi(renderWorkerLine(active, NOW))).toContain("hb=3s");
    expect(stripAnsi(renderWorkerLine(quiet, NOW))).toContain("hb=~11m+");
    expect(stripAnsi(renderWorkerLine(wedged, NOW))).toContain("hb=!11m");
    expect(stripAnsi(renderWorkerLine(quiet, NOW, "short"))).toContain("hb=~11m+");
  });

  it("renders org=<afk|go> (issue #1219): the stamped origin, defaulting to afk when unstamped", () => {
    // Unstamped worker → org=afk (an unstamped worker is an afk-fleet worker).
    expect(stripAnsi(renderWorkerLine(worker(), NOW))).toContain("org=afk");
    // A /go worker carries origin: "go".
    const go = worker({ state: { ...worker().state, origin: "go" } });
    expect(stripAnsi(renderWorkerLine(go, NOW))).toContain("org=go");
    // An explicit afk origin still renders org=afk.
    const afk = worker({ state: { ...worker().state, origin: "afk" } });
    expect(stripAnsi(renderWorkerLine(afk, NOW))).toContain("org=afk");
  });

  it("renders no per-worker fleet-attribution token (#2568 — display noise; fleet_status keeps the data)", () => {
    const attributed = worker({
      state: { ...worker().state, fleet: "alpha" },
    });

    expect(stripAnsi(renderWorkerLine(attributed, NOW))).not.toContain("flt=");
    expect(stripAnsi(renderWorkerLine(worker(), NOW))).not.toContain("unattributed");
  });

  it("short preset keeps only worker id, issue, status, and timer", () => {
    const t = stripAnsi(renderWorkerLine(worker(), NOW, "short"));
    expect(t).toContain("w1");
    expect(t).toContain("iss=17");
    expect(t.match(/[█▶░]{5}/)?.[0]).toBe("▶░░░░");
    expect(t).toContain("impl");
    expect(t).toContain("00:05:00");
    expect(t).not.toContain("run=");
    expect(t).not.toContain("org=");
    expect(t).not.toContain("loc=");
    expect(t).not.toContain("tks=");
    expect(t).not.toContain("tls=");
    expect(t).not.toContain("rsn=");
    expect(t).not.toContain("txt=");
  });

  it.each(["gate", "push-pr", "merge", "cascade"])(
    "renders landing phase %s as a distinct non-agent row (#1427)",
    (phase) => {
      const w = worker({
        state: {
          ...worker().state,
          worker_id: "wLAND",
          current: {
            ...worker().state.current,
            number: 1408,
            activity: "landing",
            phase,
            started_at: new Date((NOW - 432) * 1000).toISOString(),
          },
        },
      });
      const t = stripAnsi(renderWorkerLine(w, NOW));
      expect(t).toContain("wLAND");
      expect(t).toContain("org=landing");
      expect(t).toContain("iss=1408");
      expect(t.match(/[█▶░]{5}/)?.[0]).toBe("███▶░");
      expect(t).toContain(phase);
      expect(t).toContain("00:07:12");
      expect(t).not.toContain("loc=");
      expect(t).not.toContain("tks=");
      expect(t).not.toContain("tls=");
      expect(t).not.toContain("rsn=");
      expect(t).not.toContain("txt=");
    },
  );

  it("clears the landing row once the slot has no live worker record (#1427)", () => {
    const out = styleStatusline(input, { workers: [], now: NOW });
    const rows = out.split("\n");
    expect(rows).toHaveLength(1);
    expect(stripAnsi(out)).not.toContain("org=landing");
    expect(stripAnsi(out)).not.toContain("iss=1408");
  });

  it("populates iss=<number> for a /go-shaped worker state (no queue — total 0/done 0)", () => {
    // A /go run has no queue, so done/total are 0/0 (the old counter was meaningless);
    // current.number still carries the single issue number, set on claim like /afk.
    const w = worker({
      state: {
        ...worker().state,
        worker_id: "wGO",
        done: 0,
        total: 0,
        current: { ...worker().state.current, number: 1766 },
      },
    });
    const t = stripAnsi(renderWorkerLine(w, NOW));
    expect(t).toContain("iss=1766"); // the issue number, populated for the /go lane
    expect(t).not.toContain("iss=0/0"); // never the empty-queue counter
    expect(t).not.toContain("#1766"); // no standalone #<n>
  });

  it("omits just the effort word when the worker has no effort (run=<runner> <model>)", () => {
    const w = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, effort: undefined },
      },
    });
    const t = stripAnsi(renderWorkerLine(w, NOW));
    expect(t).toContain("run=claude opus-4.8 ");
    expect(t).not.toContain("run=claude opus-4.8 high");
  });

  it("humanizes the per-worker token total on the tks= token", () => {
    const w = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, input_tokens: 32000, output_tokens: 2000 },
      },
    });
    expect(stripAnsi(renderWorkerLine(w, NOW))).toContain("tks=34k");
  });

  it("keeps genuine zero-token codex/opencode workers numeric on the tks= token", () => {
    const codex = worker({
      state: {
        ...worker().state,
        runner: "codex",
      },
    });
    const opencode = worker({
      state: {
        ...worker().state,
        runner: "opencode",
      },
    });

    expect(stripAnsi(renderWorkerLine(codex, NOW))).toContain("tks=0");
    expect(stripAnsi(renderWorkerLine(opencode, NOW))).toContain("tks=0");
  });

  it("carries the individual vitals as k=v pairs, never a stats= blob", () => {
    const w = worker({
      state: {
        ...worker().state,
        current: {
          ...worker().state.current,
          tools_called_count: 11,
          reasoning_events: 13,
          text_chunk_count: 0,
        },
      },
    });
    const t = stripAnsi(renderWorkerLine(w, NOW));
    expect(t).toContain("tls=11 rsn=13 txt=0");
    expect(t).not.toContain("stats=");
  });

  it("renders requeue no-agent rows around gate stage and elapsed without zero activity metrics", () => {
    const w = worker({
      state: {
        ...worker().state,
        worker_id: "requeue-adopt",
        origin: "requeue",
        current: {
          ...worker().state.current,
          number: 1293,
          activity: "typecheck",
          input_tokens: 0,
          output_tokens: 0,
          tools_called_count: 0,
          reasoning_events: 0,
          text_chunk_count: 0,
        },
      },
      diffAdded: 0,
      diffRemoved: 0,
    });
    const t = stripAnsi(renderWorkerLine(w, NOW));
    expect(t).toContain("requeue-adopt");
    expect(t).toContain("run=claude opus-4.8 high");
    expect(t).toContain("org=requeue");
    expect(t).toContain("iss=1293");
    expect(t).toContain("typecheck");
    expect(t).toContain("00:05:00");
    expect(t).not.toContain("loc=+0 -0");
    expect(t).not.toContain("tks=0");
    expect(t).not.toContain("tls=0");
    expect(t).not.toContain("rsn=0");
    expect(t).not.toContain("txt=0");
  });
});

describe("statusline style — full themed assembly", () => {
  it("places the lifecycle bar between iss= and phase·activity in aligned worker rows", () => {
    const w = worker({
      state: {
        ...worker().state,
        current: { ...worker().state.current, phase: "validating" },
      },
    });
    const row = stripAnsi(styleStatusline(input, { workers: [w], now: NOW }).split("\n")[1]);

    expect(row).toContain("iss=17  ██▶░░  validating·impl");
  });

  it("emits the header row plus one row per live worker, each reset-terminated", () => {
    const out = styleStatusline(input, { workers: [worker(), worker({ state: { ...worker().state, worker_id: "w2", current: { ...worker().state.current, number: 20 } } })], now: NOW });
    const rows = out.split("\n");
    expect(rows).toHaveLength(3); // header + two workers
    expect(rows[0].endsWith(RESET)).toBe(true);
    expect(rows[1].endsWith(RESET)).toBe(true);
    expect(rows[2].endsWith(RESET)).toBe(true);
    expect(stripAnsi(rows[0])).toContain("» red-skills");
    expect(stripAnsi(rows[0])).toContain("prs=3");
    expect(stripAnsi(rows[1])).toContain("w1"); // terse worker row, no [live] badge
    expect(stripAnsi(rows[1])).toContain("run=claude opus-4.8 high");
    expect(stripAnsi(rows[1])).not.toContain("[live]");
    expect(stripAnsi(rows[2])).toContain("iss=20"); // second worker's issue number
  });

  it("emits only the header row when there are no live workers", () => {
    const out = styleStatusline(input, { workers: [], now: NOW });
    expect(out).not.toContain("\n");
    expect(stripAnsi(out)).toContain("Opus·high");
    expect(stripAnsi(out)).toContain("prs=3");
  });

  it("threads the short preset through themed assembly", () => {
    const out = styleStatusline(input, { workers: [worker()], now: NOW, preset: "short" });
    const rows = out.split("\n").map(stripAnsi);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("ctx=47k 24%");
    expect(rows[0]).toContain("iss=24");
    expect(rows[0]).not.toContain("Opus·high");
    expect(rows[0]).not.toContain("prs=");
    expect(rows[1]).toContain("w1");
    expect(rows[1]).toContain("iss=17");
    expect(rows[1]).toContain("00:05:00");
    expect(rows[1]).not.toContain("run=");
    expect(rows[1]).not.toContain("loc=");
  });

  it("aligns multi-worker rows by visible cell width while preserving ANSI color", () => {
    const out = styleStatusline(input, {
      now: NOW,
      workers: [
        worker({
          state: {
            ...worker().state,
            worker_id: "wLONG",
            runner: "codex",
            current: {
              ...worker().state.current,
              number: 1243,
              model: "gpt-5.5",
              effort: "high",
              activity: "validation",
              input_tokens: 32000,
              output_tokens: 2000,
              tools_called_count: 38,
            },
          },
          diffAdded: 248,
          diffRemoved: 29,
        }),
        worker({
          state: {
            ...worker().state,
            worker_id: "w2",
            runner: "codex",
            current: {
              ...worker().state.current,
              number: 9,
              model: undefined,
              effort: undefined,
              activity: "impl",
              tools_called_count: 8,
            },
          },
          diffAdded: 83,
          diffRemoved: 1,
        }),
      ],
    });
    const [header, firstRaw, secondRaw] = out.split("\n");
    const rows = [stripAnsi(firstRaw), stripAnsi(secondRaw)];
    for (const token of ["run=", "org=", "iss=", "00:05:00", "loc=", "tks=", "tls=", "rsn=", "txt="]) {
      const starts = rows.map((row) => row.indexOf(token));
      expect(starts[0]).toBeGreaterThanOrEqual(0);
      expect(starts[1]).toBeGreaterThanOrEqual(0);
      expect(starts[1]).toBe(starts[0]);
    }
    expect(rows[1].indexOf("impl")).toBe(rows[0].indexOf("validation"));
    expect(header).toBe(renderHeaderLine(input.project, claude, repo, undefined, "full", undefined, input.docs));
    expect(firstRaw).toContain(KEY);
    expect(secondRaw).toContain(KEY);
    expect(firstRaw).toContain(BOLD);
    expect(secondRaw).toContain(BOLD);
  });

  it("keeps agent metrics on agent rows while omitting them from requeue no-agent rows", () => {
    const out = styleStatusline(input, {
      now: NOW,
      workers: [
        worker({
          state: {
            ...worker().state,
            worker_id: "requeue-adopt",
            origin: "requeue",
            current: { ...worker().state.current, number: 1293, activity: "lint" },
          },
          diffAdded: 0,
          diffRemoved: 0,
        }),
        worker({
          state: {
            ...worker().state,
            worker_id: "wA",
            origin: "afk",
            current: { ...worker().state.current, number: 17, activity: "impl", tools_called_count: 3 },
          },
          diffAdded: 12,
          diffRemoved: 3,
        }),
      ],
    });
    const [, requeueRaw, agentRaw] = out.split("\n");
    const requeue = stripAnsi(requeueRaw);
    const agent = stripAnsi(agentRaw);
    expect(requeue).toContain("org=requeue");
    expect(requeue).toContain("lint");
    expect(requeue).not.toContain("loc=");
    expect(requeue).not.toContain("tks=");
    expect(requeue).not.toContain("tls=");
    expect(agent).toContain("org=afk");
    expect(agent).toContain("loc=+12 -3");
    expect(agent).toContain("tls=3");
  });

  it("joins phase and activity as `phase·activity`, and renders either half bare when the other is absent", () => {
    const rowFor = (current: Record<string, unknown>) => {
      const out = styleStatusline(input, {
        now: NOW,
        workers: [
          worker({
            state: {
              ...worker().state,
              worker_id: "wP",
              origin: "afk",
              current: { ...worker().state.current, ...current },
            },
          }),
        ],
      });
      return stripAnsi(out).split("\n")[1];
    };

    // Both present → joined. This is the everyday agent row.
    expect(rowFor({ number: 17, phase: "coding", activity: "impl" })).toContain("coding·impl");
    // Phase only (a worker between stream events) → bare, no dangling separator.
    const phaseOnly = rowFor({ number: 17, phase: "validating", activity: "" });
    expect(phaseOnly).toContain("validating");
    expect(phaseOnly).not.toContain("·");
    // Activity only (a no-agent gate row carries no phase) → the informative half survives.
    const activityOnly = rowFor({ number: 17, phase: "", activity: "typecheck" });
    expect(activityOnly).toContain("typecheck");
    expect(activityOnly).not.toContain("·");
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
