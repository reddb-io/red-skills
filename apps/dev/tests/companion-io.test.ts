import { describe, expect, it } from "vitest";
import {
  parseSeenFingerprints,
  resolveCompanionThresholds,
  resolveDriftCap,
  companionVitals,
  applyCorrectionBody,
  applyEscalationBody,
  summarizeCompanionPass,
  runCompanionPass,
  DEFAULT_DRIFT_CAP,
  type CompanionOutcome,
} from "../src/runtime/companion-io.js";
import { DEFAULT_COMPANION_THRESHOLDS, companionFingerprint } from "../src/core/companion.js";
import { parseState } from "../src/core/state.js";
import { loadConfig } from "../src/core/config.js";
import type { GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import type { WorkerStateRecord } from "../src/core/worker-state-reader.js";

// A worker-state record whose path encodes the issue for parseWorkerAttemptPath
// (flat workspace, no attempt ordinal — ADR 0103).
function record(issue: number, _attempt: number, current: Record<string, unknown>, live = true): WorkerStateRecord {
  return {
    path: `/r/.red/tmp/workers/host-w/${issue}/afk.state.toon`,
    state: parseState({ current: { number: issue, ...current } }),
    live,
    active: live,
    liveness: live ? "active" : "dead",
    livenessVerdict: { status: live ? "alive" : "stalled", laneFresh: live, crossCheckArmed: false, reason: "" },
    pidIdentityLive: live,
    hostPidLive: false,
    renderableLive: live,
  };
}

// A churning worker: high iteration, flat diff → iteration-churn drift.
const churn = { iteration: DEFAULT_COMPANION_THRESHOLDS.iterationChurn, loc_added: 0, loc_removed: 0, waiting_count: 0 };
// A productive worker: real diff → never drifts.
const healthy = { iteration: 99, loc_added: 200, loc_removed: 10, waiting_count: 0 };

/** Route gh calls by their argv shape, recording every write. */
function ghRouter(opts: { body?: string; comments?: string[]; labels?: string[] }): {
  ctx: GhContext;
  writes: { kind: string; args: string[] }[];
} {
  const writes: { kind: string; args: string[] }[] = [];
  const ok = (stdout: string): ExecOutput => ({ code: 0, stdout, stderr: "" });
  const exec: ExecFn = (_cmd, argv) => {
    const a = [...argv];
    // Single-object + comment-list reads route through REST (`gh api repos/...`,
    // #3730) rather than `gh issue view`; match on the REST path shape instead.
    if (a[0] === "api" && typeof a[1] === "string" && a[1].endsWith("/comments")) {
      const comments = (opts.comments ?? []).map((b) => ({
        body: b,
        author: { login: "someone", is_bot: false },
        authorAssociation: "NONE",
        createdAt: undefined,
      }));
      return Promise.resolve(ok(JSON.stringify({ comments })));
    }
    if (a[0] === "api" && typeof a[1] === "string" && /\/issues\/\d+$/.test(a[1])) {
      const labels = (opts.labels ?? []).map((name) => ({ name }));
      return Promise.resolve(ok(JSON.stringify({ number: 7, title: "t", body: opts.body ?? "", labels })));
    }
    if (a[0] === "issue" && a[1] === "view" && a.includes("comments") && !a.includes("body")) {
      const comments = (opts.comments ?? []).map((b) => ({ body: b }));
      return Promise.resolve(ok(JSON.stringify({ comments })));
    }
    if (a[0] === "issue" && a[1] === "view") {
      const labels = (opts.labels ?? []).map((name) => ({ name }));
      return Promise.resolve(ok(JSON.stringify({ number: 7, title: "t", body: opts.body ?? "", labels })));
    }
    // Writes route through REST too (#3734): `gh api -X PATCH/POST <path> …`
    // replaces the old `gh issue edit/comment` CLI forms.
    if (a[0] === "api" && a[1] === "-X" && a[2] === "POST" && typeof a[3] === "string" && a[3].endsWith("/comments")) {
      writes.push({ kind: "comment", args: a });
      return Promise.resolve(ok(""));
    }
    if (a[0] === "api" && a[1] === "-X" && a[2] === "PATCH" && a.some((arg) => typeof arg === "string" && arg.startsWith("body="))) {
      writes.push({ kind: "editBody", args: a });
      return Promise.resolve(ok(""));
    }
    if (a[0] === "api" && a[1] === "-X" && a[2] === "PATCH" && a.some((arg) => typeof arg === "string" && arg.startsWith("labels[]"))) {
      writes.push({ kind: "editLabels", args: a });
      return Promise.resolve(ok(""));
    }
    if (a[0] === "issue" && a[1] === "edit" && a.includes("--body")) {
      writes.push({ kind: "editBody", args: a });
      return Promise.resolve(ok(""));
    }
    if (a[0] === "issue" && a[1] === "edit") {
      writes.push({ kind: "editLabels", args: a });
      return Promise.resolve(ok(""));
    }
    if (a[0] === "issue" && a[1] === "comment") {
      writes.push({ kind: "comment", args: a });
      return Promise.resolve(ok(""));
    }
    return Promise.resolve(ok(""));
  };
  return { ctx: { cwd: "/r", repo: "acme/widgets", exec }, writes };
}

const T = DEFAULT_COMPANION_THRESHOLDS;

describe("resolveCompanionThresholds (#921)", () => {
  it("defaults when config is empty", () => {
    expect(resolveCompanionThresholds(loadConfig("/nope", { ignoreActivationGate: true }))).toEqual(T);
  });
  it("reads the namespaced plugins.dev.afk.companion.* block", () => {
    const cfg = loadConfig("/x", { ignoreActivationGate: true,
      read: () => "plugins:\n  dev:\n    afk:\n      companion:\n        iteration_churn: 3\n",
    });
    expect(resolveCompanionThresholds(cfg).iterationChurn).toBe(3);
  });
  it("a non-positive override falls back to the default (no 0-threshold footgun)", () => {
    const cfg = loadConfig("/x", { ignoreActivationGate: true, read: () => "afk:\n  companion:\n    waiting_windows: 0\n" });
    expect(resolveCompanionThresholds(cfg).waitingWindows).toBe(T.waitingWindows);
  });
});

describe("resolveDriftCap (#921)", () => {
  it("defaults to 2 and honours RED_AFK_RETRY_DRIFT", () => {
    expect(resolveDriftCap({})).toBe(DEFAULT_DRIFT_CAP);
    expect(resolveDriftCap({ RED_AFK_RETRY_DRIFT: "5" })).toBe(5);
  });
});

describe("companionVitals (#921)", () => {
  it("projects current.* and coerces a non-numeric iteration to 0", () => {
    expect(companionVitals(parseState({ current: { iteration: "", loc_added: 4, loc_removed: 1, waiting_count: 9 } }))).toEqual(
      { iteration: 0, locAdded: 4, locRemoved: 1, waiting: 9 },
    );
    expect(companionVitals(parseState({ current: { iteration: 6 } })).iteration).toBe(6);
  });
});

describe("parseSeenFingerprints (#921)", () => {
  it("extracts fingerprints from comment bodies (visible or HTML-comment marker)", () => {
    const set = parseSeenFingerprints([
      `noise\n<!-- ${companionFingerprint(7, "iteration-churn")} -->\nmore`,
      "unrelated comment",
    ]);
    expect(set.has(companionFingerprint(7, "iteration-churn"))).toBe(true);
    expect(set.size).toBe(1);
  });
});

describe("body rewrites (#921)", () => {
  it("correction upserts the ## Agent brief section with byte-exact anchors", () => {
    const out = applyCorrectionBody("## Parent\n#1\n", "Stop and change strategy.", "iteration-churn");
    expect(out).toMatch(/## Agent brief/);
    expect(out).toContain("<!-- red:agent-brief v1 -->");
    expect(out).toContain("<!-- /red:agent-brief -->");
    expect(out).toContain("Stop and change strategy.");
    expect(out).toContain("## Parent");
  });
  it("correction preserves bytes outside the anchored region on re-correction", () => {
    // First correction plants the anchors.
    const first = applyCorrectionBody("## Parent\n#1\n\n## Notes\nKeep this.\n", "Stop.", "iteration-churn");
    const openIdx = first.indexOf("<!-- red:agent-brief v1 -->");
    const closeIdx = first.indexOf("<!-- /red:agent-brief -->");
    const before = first.slice(0, openIdx);
    const after = first.slice(closeIdx + "<!-- /red:agent-brief -->".length);
    // Second correction reuses the fast path — outer bytes are identical.
    const second = applyCorrectionBody(first, "Try again.", "iteration-churn");
    const openIdx2 = second.indexOf("<!-- red:agent-brief v1 -->");
    const closeIdx2 = second.indexOf("<!-- /red:agent-brief -->");
    expect(second.slice(0, openIdx2)).toBe(before);
    expect(second.slice(closeIdx2 + "<!-- /red:agent-brief -->".length)).toBe(after);
    expect(second).toContain("Try again.");
  });
  it("escalation opens a ## Current blocker with kind drift", () => {
    const out = applyEscalationBody("## Parent\n#1\n", "stuck-waiting", "budget spent.");
    expect(out).toMatch(/## Current blocker/);
    expect(out).toContain("kind: drift");
  });
});

describe("runCompanionPass (#921)", () => {
  it("a clean fleet writes nothing and never reads an issue", async () => {
    const gh = ghRouter({});
    const outcomes = await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      cap: 2,
      readStates: async () => [record(7, 1, healthy)],
    });
    expect(gh.writes).toHaveLength(0);
    expect(outcomes).toEqual<CompanionOutcome[]>([{ issue: 7, attempt: 1, disposition: "clean" }]);
  });

  it("a drifting worker rewrites the body, posts a fingerprinted comment, and re-enqueues", async () => {
    const gh = ghRouter({ body: "## Parent\n#1\n" });
    const outcomes = await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      cap: 2,
      readStates: async () => [record(7, 1, churn)],
    });
    expect(outcomes[0]?.disposition).toBe("corrected");
    const body = gh.writes.find((w) => w.kind === "editBody");
    expect(body?.args.join(" ")).toContain("## Agent brief");
    expect(body?.args.join(" ")).toContain("<!-- red:agent-brief v1 -->");
    const comment = gh.writes.find((w) => w.kind === "comment");
    expect(comment?.args.join(" ")).toContain(companionFingerprint(7, "iteration-churn"));
    // The label write routes through REST (#3734): the final label SET is sent
    // as one `-F labels[]=<name>` pair per label, replacing `--add-label`.
    const labels = gh.writes.find((w) => w.kind === "editLabels");
    expect(labels?.args).toContain("labels[]=ready-for-agent");
  });

  it("is idempotent — an existing fingerprint suppresses a second write", async () => {
    const gh = ghRouter({ body: "x", comments: [`<!-- ${companionFingerprint(7, "iteration-churn")} -->`] });
    const outcomes = await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      cap: 2,
      readStates: async () => [record(7, 1, churn)],
    });
    expect(gh.writes).toHaveLength(0);
    expect(outcomes[0]?.disposition).toBe("skipped-idempotent");
  });

  it("escalates to ready-for-human once the cap is spent (removing the present ready-for-agent)", async () => {
    const gh = ghRouter({ body: "x", labels: ["ready-for-agent"] });
    const outcomes = await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      // With the attempt ordinal retired (ADR 0103) the enumerator always
      // reports attempt 1, so the budget gate fires at cap <= 1. The real
      // retry budget moves to the re-queue policy (#2172/#2174 contraction).
      cap: 1,
      readStates: async () => [record(7, 1, churn)],
    });
    expect(outcomes[0]?.disposition).toBe("escalated");
    const body = gh.writes.find((w) => w.kind === "editBody");
    expect(body?.args.join(" ")).toContain("## Current blocker");
    // REST replaces the WHOLE label set in one PATCH (#3734): the removal of
    // the present ready-for-agent shows up as its ABSENCE from the sent set,
    // not as a separate --remove-label flag.
    const labels = gh.writes.find((w) => w.kind === "editLabels");
    expect(labels?.args).toContain("labels[]=ready-for-human");
    expect(labels?.args).not.toContain("labels[]=ready-for-agent");
  });

  it("escalation does not emit a one-sided remove for an absent ready-for-agent", async () => {
    const gh = ghRouter({ body: "x" }); // no labels present
    await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      // With the attempt ordinal retired (ADR 0103) the enumerator always
      // reports attempt 1, so the budget gate fires at cap <= 1. The real
      // retry budget moves to the re-queue policy (#2172/#2174 contraction).
      cap: 1,
      readStates: async () => [record(7, 1, churn)],
    });
    // No ready-for-agent was present to begin with, so the REST full-set write
    // (#3734) naturally omits it — there is no separate --remove-label flag to
    // fire one-sidedly in the first place.
    const labels = gh.writes.find((w) => w.kind === "editLabels");
    expect(labels?.args).toContain("labels[]=ready-for-human");
    expect(labels?.args).not.toContain("labels[]=ready-for-agent");
  });

  it("skips a dead worker (the reaper's job, not the companion's)", async () => {
    const gh = ghRouter({ body: "x" });
    const outcomes = await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      cap: 2,
      readStates: async () => [record(7, 1, churn, false)],
    });
    expect(outcomes).toHaveLength(0);
    expect(gh.writes).toHaveLength(0);
  });

  it("dry-run computes the plan but performs no gh write", async () => {
    const gh = ghRouter({ body: "x" });
    const outcomes = await runCompanionPass({
      workersRoot: "/r/.red/tmp/workers",
      ctx: gh.ctx,
      thresholds: T,
      cap: 2,
      dryRun: true,
      readStates: async () => [record(7, 1, churn)],
    });
    expect(outcomes[0]?.disposition).toBe("corrected");
    expect(gh.writes).toHaveLength(0);
  });
});

describe("summarizeCompanionPass (#921)", () => {
  it("is empty for a calm fleet and names actions otherwise", () => {
    expect(summarizeCompanionPass([{ issue: 7, attempt: 1, disposition: "clean" }])).toBe("");
    const s = summarizeCompanionPass([{ issue: 7, attempt: 1, disposition: "corrected", signal: "iteration-churn" }]);
    expect(s).toContain("#7 a1 correct (iteration-churn)");
  });
});
