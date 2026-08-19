import { describe, expect, it, vi } from "vitest";
import {
  buildDiffSection,
  buildEnvelopeSummary,
  buildFailureMarkers,
  envelopeReference,
  buildSections,
  emitEnvelope,
  fmtDuration,
  type EmitEnvelopeDeps,
  type FailureMarkers,
} from "../src/core/envelope-emit.js";
import type { GitExecResult } from "../src/core/remote-branch.js";
import type { historyAppend as HistoryAppendFn } from "../src/core/history.js";

// ---------- fakes ----------

/** A capturing git that records argv and replies with a fixed exit code. */
function fakeGit(code: number) {
  const calls: string[][] = [];
  const git = async (args: string[]): Promise<GitExecResult> => {
    calls.push(args);
    return { code, stdout: "", stderr: "" };
  };
  return { git, calls };
}

/** A capturing poster with a configurable success flag. */
function fakePoster(ok: boolean) {
  const calls: Array<{ issue: number; body: string }> = [];
  const poster = async (issue: number, body: string): Promise<boolean> => {
    calls.push({ issue, body });
    return ok;
  };
  return { poster, calls };
}

function fakeMarkerWriter() {
  const written: FailureMarkers[] = [];
  const writeMarkers = async (m: FailureMarkers): Promise<void> => {
    written.push(m);
  };
  return { writeMarkers, written };
}

function fakePostedWriter() {
  const writes: boolean[] = [];
  const writePosted = async (posted: boolean): Promise<void> => {
    writes.push(posted);
  };
  return { writePosted, writes };
}

/** Builds a full deps bundle (success git+poster by default) with capture handles. */
function makeDeps(opts: { gitCode?: number; posterOk?: boolean } = {}) {
  const git = fakeGit(opts.gitCode ?? 0);
  const poster = fakePoster(opts.posterOk ?? true);
  const markers = fakeMarkerWriter();
  const posted = fakePostedWriter();
  const historyAppend = vi.fn<typeof HistoryAppendFn>(async () => ({}) as never);
  const deps: EmitEnvelopeDeps = {
    git: git.git,
    poster: poster.poster,
    writeMarkers: markers.writeMarkers,
    writePosted: posted.writePosted,
    historyAppend,
  };
  return { deps, git, poster, markers, posted, historyAppend };
}

// ===========================================================================
// pure helpers
// ===========================================================================

describe("fmtDuration", () => {
  it("renders <m>m<s>s, matching envelope_fmt_duration", () => {
    expect(fmtDuration(0)).toBe("0m0s");
    expect(fmtDuration(65)).toBe("1m5s");
    expect(fmtDuration(3599)).toBe("59m59s");
  });
});

describe("buildEnvelopeSummary", () => {
  it("omits merge when no sha (blocked)", () => {
    const s = buildEnvelopeSummary({ worker: "wTEST", status: "blocked", durationS: 125, diff: "+42 -10", attempt: 1 });
    expect(s).toBe("worker `wTEST` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1");
    expect(s).not.toContain("merge:");
  });

  it("wraps the merge sha in backticks (done)", () => {
    const s = buildEnvelopeSummary({ worker: "wTEST", status: "done", durationS: 600, diff: "merged", attempt: 2, mergeSha: "abcdef1" });
    expect(s).toContain("diff: merged");
    expect(s).toContain("attempt: 2");
    expect(s).toContain("merge: `abcdef1`");
  });
});

describe("buildDiffSection", () => {
  it("uses the live worker branch as the failure forensic ref", () => {
    const body = buildDiffSection({ repo: "reddb-io/red-skills", remoteBranch: "", worktreeRel: ".red/tmp/work-wTEST-i9/worktree", diffstat: "+12 -3 files=2" });
    expect(body).toContain("local worktree: `.red/tmp/work-wTEST-i9/worktree`");
    expect(body).toContain("+12 -3 files=2");
    expect(body).not.toContain("compare/main...");
    expect(body).not.toContain("afk-attempts");
  });

  it("renders a clickable live-branch tree link when liveBranch is set (#443)", () => {
    const body = buildDiffSection({
      repo: "reddb-io/red-skills",
      remoteBranch: "",
      worktreeRel: ".red/tmp/w",
      diffstat: "+12 -3 files=2",
      liveBranch: "afk/wTEST/9-foo",
    });
    expect(body).toContain("live branch:");
    expect(body).toContain("https://github.com/reddb-io/red-skills/tree/afk/wTEST/9-foo");
    expect(body).not.toContain("compare/main...");
    expect(body).not.toContain("afk-attempts");
  });

  it("omits the live-branch link when liveBranch is absent", () => {
    const body = buildDiffSection({ repo: "reddb-io/red-skills", remoteBranch: "", worktreeRel: ".red/tmp/w", diffstat: "+0 -0" });
    expect(body).not.toContain("live branch:");
  });
});

describe("buildFailureMarkers", () => {
  it("writes the failure reason and the envelope ref, each with a trailing newline", () => {
    expect(buildFailureMarkers("the reason", "https://github.com/o/r/issues/9")).toEqual({
      failureReason: "the reason\n",
      envelopeRef: "https://github.com/o/r/issues/9\n",
    });
  });

  it("omits the envelope ref when the caller has none", () => {
    expect(buildFailureMarkers("r")).toEqual({ failureReason: "r\n" });
  });
});

describe("envelopeReference", () => {
  it("points at the issue thread the terminal envelope is posted into", () => {
    expect(envelopeReference("reddb-io/red-skills", 2174)).toBe(
      "https://github.com/reddb-io/red-skills/issues/2174",
    );
  });

  it("is empty when the repo is unknown", () => {
    expect(envelopeReference(undefined, 2174)).toBe("");
  });
});

// ===========================================================================
// per-status section sets
// ===========================================================================

describe("buildSections", () => {
  const diff = { repo: "r/n", worktreeRel: ".w", diffstat: "+1 -0 files=1" };

  it("blocked → notes + diff (no log)", () => {
    const s = buildSections("blocked", { notes: "halted" }, diff, "r/n-attempts");
    expect(s.map((x) => x.name)).toEqual(["notes", "diff"]);
  });

  it("blocked with validation → notes + validation + diff", () => {
    const s = buildSections("blocked", { notes: "halted", validation: "cargo fmt --all -- --check → exit=1" }, diff, "r/n-attempts");
    expect(s.map((x) => x.name)).toEqual(["notes", "validation", "diff"]);
  });

  it("no-sentinel → notes + diff + log (log fenced as TOON)", () => {
    const s = buildSections("no-sentinel", { notes: "n", log: "line C" }, diff, "remote");
    expect(s.map((x) => x.name)).toEqual(["notes", "diff", "log"]);
    expect(s.find((x) => x.name === "log")?.fenced).toBe(true);
    expect(s.find((x) => x.name === "log")?.fenceLang).toBe("toon");
  });

  it("merge-conflict → diff + log (no notes)", () => {
    const s = buildSections("merge-conflict", { log: "CONFLICT" }, diff, "remote");
    expect(s.map((x) => x.name)).toEqual(["diff", "log"]);
  });

  it("done → validation only", () => {
    const s = buildSections("done", { validation: "test:x:✓" }, diff, "");
    expect(s.map((x) => x.name)).toEqual(["validation"]);
  });

  it("appends a trailing hooks block last (issue #215)", () => {
    const s = buildSections("no-sentinel", { notes: "n", log: "l", hooks: "pre_merge cmd exit=0" }, diff, "remote");
    expect(s.map((x) => x.name)).toEqual(["notes", "diff", "log", "hooks"]);
  });

  it("skips the hooks block when no user hook ran", () => {
    const s = buildSections("done", { validation: "v", hooks: "" }, diff, "");
    expect(s.map((x) => x.name)).toEqual(["validation"]);
  });
});

// ===========================================================================
// emitEnvelope orchestration — summary line + section set per status
// ===========================================================================

describe("emitEnvelope — per-status summary + sections", () => {
  it("blocked: summary line + notes/diff sections, no log", async () => {
    const { deps, poster } = makeDeps();
    const res = await emitEnvelope(deps, {
      status: "blocked",
      issue: 11,
      worker: "wTEST",
      durationS: 125,
      branch: "afk/wTEST/11-foo",
      attempt: 1,
      diff: "+42 -10",
      remoteName: "afk-attempts/wTEST/11-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".red/tmp/work-wTEST-i11/worktree",
      diffstat: "+42 -10 files=3",
      sections: { notes: "agent could not reproduce, halted" },
    });
    expect(res.summary).toBe("worker `wTEST` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1");
    expect(poster.calls[0]?.issue).toBe(11);
    expect(res.body).toContain('<details data-attempt-status="blocked">');
    expect(res.body).toContain("worker `wTEST` · status: blocked");
    expect(res.body).toContain('<details data-section="notes">');
    expect(res.body).toContain("agent could not reproduce, halted");
    expect(res.body).toContain('<details data-section="diff">');
    expect(res.body).not.toContain('data-section="log"');
    // notes precedes diff
    expect(res.body.indexOf('data-section="notes"')).toBeLessThan(res.body.indexOf('data-section="diff"'));
  });

  it("blocked: renders validation details when provided", async () => {
    const { deps } = makeDeps();
    const res = await emitEnvelope(deps, {
      status: "blocked",
      issue: 11,
      worker: "wTEST",
      durationS: 125,
      branch: "afk/wTEST/11-foo",
      attempt: 1,
      diff: "+42 -10",
      remoteName: "afk-attempts/wTEST/11-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".red/tmp/work-wTEST-i11/worktree",
      diffstat: "+42 -10 files=3",
      sections: { notes: "feedback failed", validation: "cargo clippy --workspace → exit=1" },
    });
    expect(res.body).toContain('<details data-section="validation">');
    expect(res.body).toContain("cargo clippy --workspace → exit=1");
    expect(res.body.indexOf('data-section="notes"')).toBeLessThan(res.body.indexOf('data-section="validation"'));
    expect(res.body.indexOf('data-section="validation"')).toBeLessThan(res.body.indexOf('data-section="diff"'));
  });

  it("enriches issue refs in notes while leaving log text literal", async () => {
    const { deps } = makeDeps();
    deps.issueReference = async (issue) =>
      issue === 42
        ? { number: 42, title: "Wayfinder fidelity restoration", url: "https://github.com/reddb-io/red-skills/issues/42" }
        : undefined;
    const res = await emitEnvelope(deps, {
      status: "no-sentinel",
      issue: 12,
      worker: "wTEST",
      durationS: 30,
      branch: "afk/wTEST/12-foo",
      attempt: 1,
      diff: "+0 -0",
      remoteName: "afk-attempts/wTEST/12-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".w",
      diffstat: "+0 -0 files=0",
      sections: { notes: "blocked behind #42 and #404", log: "grep saw #42" },
    });

    expect(res.body).toContain("[Wayfinder fidelity restoration (#42)](https://github.com/reddb-io/red-skills/issues/42)");
    expect(res.body).toContain("#404");
    expect(res.body).toContain("grep saw #42");
  });

  it("no-sentinel: notes < diff < log, log fenced as TOON", async () => {
    const { deps } = makeDeps();
    const res = await emitEnvelope(deps, {
      status: "no-sentinel",
      issue: 12,
      worker: "wTEST",
      durationS: 30,
      branch: "afk/wTEST/12-foo",
      attempt: 1,
      diff: "+0 -0",
      remoteName: "afk-attempts/wTEST/12-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".w",
      diffstat: "+0 -0 files=0",
      sections: { notes: "no notes appended", log: "line A\nline B\nline C" },
    });
    expect(res.body).toContain('<details data-attempt-status="no-sentinel">');
    expect(res.body).toContain('<details data-section="log">');
    expect(res.body).toContain("```toon");
    expect(res.body).toContain("line C");
    const n = res.body.indexOf('data-section="notes"');
    const d = res.body.indexOf('data-section="diff"');
    const l = res.body.indexOf('data-section="log"');
    expect(n).toBeLessThan(d);
    expect(d).toBeLessThan(l);
  });

  it("merge-conflict: diff + log, no notes", async () => {
    const { deps } = makeDeps();
    const res = await emitEnvelope(deps, {
      status: "merge-conflict",
      issue: 13,
      worker: "wTEST",
      durationS: 800,
      branch: "afk/wTEST/13-foo",
      attempt: 1,
      diff: "+12 -3",
      remoteName: "afk-attempts/wTEST/13-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".w",
      diffstat: "+12 -3 files=2",
      sections: { log: "CONFLICT (content): Merge conflict in foo" },
    });
    expect(res.body).toContain('<details data-attempt-status="merge-conflict">');
    expect(res.body).toContain('<details data-section="diff">');
    expect(res.body).toContain('<details data-section="log">');
    expect(res.body).toContain("```toon");
    expect(res.body).toContain("CONFLICT (content)");
    expect(res.body).not.toContain('data-section="notes"');
  });
});

// ===========================================================================
// done: validation section + merge sha, no push
// ===========================================================================

describe("emitEnvelope — done", () => {
  it("carries the validation section + merge sha and never pushes", async () => {
    const { deps, git, markers } = makeDeps();
    const res = await emitEnvelope(deps, {
      status: "done",
      issue: 20,
      worker: "wTEST",
      durationS: 600,
      branch: "afk/wTEST/20-foo",
      attempt: 2,
      mergeSha: "abcdef1",
      diff: "merged",
      sections: { validation: "test:plugins/memory:✓ typecheck:plugins/memory:skip" },
    });
    expect(res.body).toContain('<details data-attempt-status="done">');
    // buildEnvelope (reused) renders the summary's merge sha bare for GitHub
    // auto-linking; the returned .summary keeps the bash backtick shape.
    expect(res.body).toContain("merge: abcdef1");
    expect(res.summary).toContain("merge: `abcdef1`");
    expect(res.body).toContain('<details data-section="validation">');
    expect(res.body).toContain("test:plugins/memory:✓");
    expect(res.body).not.toContain('data-section="diff"');
    expect(res.body).not.toContain('data-section="notes"');
    expect(res.body).not.toContain('data-section="log"');
    // done never pushes the afk-attempts branch and writes no failure markers
    expect(git.calls).toHaveLength(0);
    expect(res.pushed).toBe(false);
    expect(markers.written).toHaveLength(0);
  });

  it("appends a done history event after a successful post", async () => {
    const { deps, historyAppend } = makeDeps();
    await emitEnvelope(deps, {
      status: "done",
      issue: 20,
      worker: "wTEST",
      durationS: 600,
      branch: "b",
      attempt: 2,
      mergeSha: "abcdef1",
      diff: "merged",
      historyPath: "/ledger.jsonl",
      historyClock: { ts: "2026-05-30T00:00:00Z", epoch: 1748563200 },
      historyFields: { runner: "claude", merge_sha: "abcdef1", duration_s: 600 },
    });
    expect(historyAppend).toHaveBeenCalledTimes(1);
    const [path, , event, fields] = historyAppend.mock.calls[0]!;
    expect(path).toBe("/ledger.jsonl");
    expect(event).toBe("done");
    expect(fields).toMatchObject({ worker: "wTEST", issue: 20, runner: "claude" });
  });

  // Regression (#625): the local history ledger is independent of the GitHub
  // comment POST. A transient post failure must NOT drop the terminal record —
  // before the fix the append sat in an `else if (posted)` branch, so the
  // 2026-06-09 gap saw three issues land with no `done` record (frozen sparkline).
  it("appends the history event even when the comment POST fails (#625)", async () => {
    const { deps, historyAppend, posted } = makeDeps({ posterOk: false });
    const res = await emitEnvelope(deps, {
      status: "done",
      issue: 21,
      worker: "wTEST",
      durationS: 600,
      branch: "b",
      attempt: 1,
      mergeSha: "abcdef1",
      diff: "merged",
      historyPath: "/ledger.jsonl",
      historyClock: { ts: "2026-05-30T00:00:00Z", epoch: 1748563200 },
      historyFields: { runner: "claude", merge_sha: "abcdef1", duration_s: 600 },
    });
    // posted=false is still surfaced (warning + signal), but the ledger append fires anyway.
    expect(res.posted).toBe(false);
    expect(posted.writes).toContain(false);
    expect(res.warnings.some((w) => w.includes("failed to post envelope"))).toBe(true);
    expect(historyAppend).toHaveBeenCalledTimes(1);
    const [path, , event, fields] = historyAppend.mock.calls[0]!;
    expect(path).toBe("/ledger.jsonl");
    expect(event).toBe("done");
    expect(fields).toMatchObject({ worker: "wTEST", issue: 21 });
  });
});

// ===========================================================================
// failure flow: push happens + markers written + posted flag
// ===========================================================================

describe("emitEnvelope — failure markers/posted flow", () => {
  it("does not push a snapshot branch and writes the failure reason + envelope ref", async () => {
    const { deps, git, markers, posted } = makeDeps({ gitCode: 0, posterOk: true });
    const res = await emitEnvelope(deps, {
      status: "blocked",
      issue: 11,
      worker: "wTEST",
      durationS: 60,
      branch: "afk/wTEST/11-foo",
      attempt: 1,
      diff: "+12 -3",
      remoteName: "afk-attempts/wTEST/11-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".w",
      diffstat: "+12 -3 files=2",
      sections: { notes: "halted" },
    });
    expect(git.calls).toHaveLength(0);
    expect(res.pushed).toBe(false);
    expect(res.remoteBranch).toBe("");
    expect(markers.written).toHaveLength(1);
    expect(markers.written[0]).toEqual({
      failureReason: `${res.summary}\n`,
      envelopeRef: "https://github.com/reddb-io/red-skills/issues/11\n",
    });
    expect(res.posted).toBe(true);
    expect(posted.writes).toEqual([true]);
    expect(res.body).toContain("live branch:");
    expect(res.body).not.toContain("afk-attempts");
  });

  it("ignores legacy remoteName inputs instead of attempting a snapshot push", async () => {
    const { deps, git, markers } = makeDeps({ gitCode: 1, posterOk: true });
    const res = await emitEnvelope(deps, {
      status: "merge-conflict",
      issue: 13,
      worker: "wTEST",
      durationS: 800,
      branch: "afk/wTEST/13-foo",
      attempt: 1,
      diff: "+12 -3",
      remoteName: "afk-attempts/wTEST/13-foo",
      repo: "reddb-io/red-skills",
      repoDir: "/tmp/x",
      worktreeRel: ".red/tmp/work-wTEST-i13/worktree",
      diffstat: "+12 -3 files=2",
      sections: { log: "CONFLICT" },
    });
    expect(git.calls).toHaveLength(0);
    expect(res.pushed).toBe(false);
    expect(res.remoteBranch).toBe("");
    expect(res.body).toContain("live branch:");
    expect(res.body).not.toContain("compare/main...");
    expect(markers.written[0]?.envelopeRef).toBe("https://github.com/reddb-io/red-skills/issues/13\n");
    expect(res.warnings).toEqual([]);
  });

  it("sets posted=false but still appends the history event when the post fails (#625)", async () => {
    const { deps, posted, historyAppend } = makeDeps({ gitCode: 0, posterOk: false });
    const res = await emitEnvelope(deps, {
      status: "blocked",
      issue: 11,
      worker: "wTEST",
      durationS: 60,
      branch: "afk/wTEST/11-foo",
      attempt: 1,
      diff: "+1 -0",
      remoteName: "afk-attempts/wTEST/11-foo",
      repo: "r/n",
      repoDir: "/tmp/x",
      worktreeRel: ".w",
      diffstat: "+1 -0 files=1",
      sections: { notes: "n" },
      historyPath: "/ledger.jsonl",
      historyClock: { ts: "t", epoch: 1 },
    });
    expect(res.posted).toBe(false);
    expect(posted.writes).toEqual([false]);
    // #625: the ledger append is independent of the comment POST — a failed
    // post still surfaces the warning, but the terminal `blocked` record lands.
    expect(historyAppend).toHaveBeenCalledTimes(1);
    expect(historyAppend.mock.calls[0]![2]).toBe("blocked");
    expect(res.warnings.some((w) => w.includes("failed to post envelope for #11"))).toBe(true);
  });
});

// The DESCRIPTIVE typed-blocked mapping moved to attempt-outcome (the single
// owner of the outcome vocabulary); its exhaustive table lives in
// tests/attempt-outcome.test.ts.
