import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../src/core/envelope.js";
import type { AttemptStatus } from "../src/core/envelope.js";
import {
  buildHandoff,
  buildHumanGuidance,
  buildPreviousAttempts,
  buildThreadDiscussion,
  EXIT_PROTOCOL,
  type HandoffComment,
} from "../src/core/handoff.js";

// ---------- fixtures (mirrors handoff-builder.test.sh) ----------

/** An envelope body shaped exactly as emit_envelope posts it on the thread. */
function makeEnvelope(
  status: AttemptStatus,
  worker: string,
  duration: string,
  attempt: number,
  notesBody: string,
  logBody?: string,
): string {
  const sections = [{ name: "notes", body: notesBody }];
  if (logBody !== undefined) sections.push({ name: "log", body: logBody, fenced: true } as never);
  return buildEnvelope({ status, worker, duration, diff: "+5 -2", attempt, sections });
}

/** Own-line directive marker, as extractDirectives requires. */
function directiveMarker(content: string): string {
  return `<details data-kind="directive">\n<summary>directive</summary>\n${content}\n</details>`;
}

const BOOT =
  "🤖 /afk started at `2026-05-18T12:00:00-03:00` on runner `claude` (worker `wAB12`). worktree: `.red/tmp/x`";
const PROMO = "🤖 /afk promoted to ready-for-agent: all blockers closed (#3 #4).";
const HEART = ":two:";
const ENV_NOSTATUS = "<details><summary>boring</summary>\nstuff\n</details>";

function base(overrides: Partial<Parameters<typeof buildHandoff>[0]>) {
  return buildHandoff({
    issue: 1,
    title: "T",
    body: "body",
    runner: "claude",
    started: "2026-05-30T00:00:00Z",
    attempt: 1,
    url: "url",
    comments: [],
    ...overrides,
  });
}

// ---------- envelope field/section parsing (via buildPreviousAttempts) ----------

describe("buildPreviousAttempts", () => {
  it("emits a <previous-attempt> with status/worker/duration and notes", () => {
    const env = makeEnvelope("blocked", "wTEST", "2m5s", 1, "something halted");
    const out = buildPreviousAttempts([{ body: env }]);
    expect(out).toContain('<previous-attempt n="1" status="blocked"');
    expect(out).toContain('worker="wTEST"');
    expect(out).toContain('duration="2m5s"');
    expect(out).toContain("<notes>\nsomething halted\n</notes>");
    expect(out).toContain("</previous-attempt>");
  });

  it("strips ``` fences from a log section", () => {
    const env = makeEnvelope("no-sentinel", "wTEST", "3m0s", 2, "no notes", "line A\nline B\nline C");
    const out = buildPreviousAttempts([{ body: env }]);
    expect(out).toContain("<log>\nline A\nline B\nline C\n</log>");
  });

  it("numbers attempts in order across multiple envelopes", () => {
    const e1 = makeEnvelope("blocked", "w1", "1m0s", 1, "first");
    const e2 = makeEnvelope("done", "w2", "2m0s", 2, "second");
    const out = buildPreviousAttempts([{ body: e1 }, { body: e2 }]);
    expect(out).toContain('<previous-attempt n="1" status="blocked"');
    expect(out).toContain('<previous-attempt n="2" status="done"');
  });

  it("non-envelope comments contribute nothing", () => {
    expect(buildPreviousAttempts([{ body: BOOT }, { body: "narrative" }])).toBe("");
    // malformed envelope (no data-attempt-status) is not a real attempt
    expect(buildPreviousAttempts([{ body: ENV_NOSTATUS }])).toBe("");
  });
});

// ---------- directive routing ----------

describe("buildHumanGuidance", () => {
  it("one directive → one element with author/at", () => {
    const c: HandoffComment = {
      author: "alice",
      createdAt: "2026-05-18T10:30:00Z",
      body: directiveMarker("keep foo, just deprecate it"),
    };
    const out = buildHumanGuidance([c]);
    expect(out).toContain('<human-guidance author="@alice" at="2026-05-18T10:30:00Z">');
    expect(out).toContain("keep foo, just deprecate it");
    expect(out).toContain("</human-guidance>");
    expect(out.match(/<human-guidance author=/g)).toHaveLength(1);
  });

  it("two markers in one comment → two siblings, identical author/at, doc order", () => {
    const body = `${directiveMarker("first directive")}\n\nchatter\n\n${directiveMarker("second directive")}`;
    const out = buildHumanGuidance([{ author: "carol", createdAt: "2026-05-18T11:00:00Z", body }]);
    expect(out.match(/<human-guidance author=/g)).toHaveLength(2);
    expect(out.match(/<human-guidance author="@carol" at="2026-05-18T11:00:00Z">/g)).toHaveLength(2);
    expect(out.indexOf("first directive")).toBeLessThan(out.indexOf("second directive"));
    // the inter-marker chatter is not its own element
    expect(out).not.toContain("chatter\n</human-guidance>");
  });

  it("omits at=\"\" when createdAt is absent", () => {
    const out = buildHumanGuidance([{ author: "dave", body: directiveMarker("x") }]);
    expect(out).toContain('<human-guidance author="@dave">');
    expect(out).not.toContain("at=");
  });

  it("missing author defaults to unknown", () => {
    const out = buildHumanGuidance([{ body: directiveMarker("x"), createdAt: "t" }]);
    expect(out).toContain('<human-guidance author="@unknown"');
  });

  it("no directive marker → empty", () => {
    expect(buildHumanGuidance([{ body: "just talking", author: "a" }])).toBe("");
  });
});

describe("buildThreadDiscussion", () => {
  it("narrative comment → one entry, verbatim body", () => {
    const out = buildThreadDiscussion([
      { author: "bob", createdAt: "2026-05-18T10:35:00Z", body: "the parser needs empty bodies" },
    ]);
    expect(out).toContain('<thread-discussion-entry author="@bob" at="2026-05-18T10:35:00Z">');
    expect(out).toContain("the parser needs empty bodies");
    expect(out).toContain("</thread-discussion-entry>");
  });

  it("malformed envelope (no marker, not a real attempt) degrades to discussion", () => {
    const out = buildThreadDiscussion([{ author: "agent", body: ENV_NOSTATUS }]);
    expect(out).toContain("boring");
  });

  it("audit noise and directive comments are excluded", () => {
    const out = buildThreadDiscussion([
      { body: BOOT },
      { body: PROMO },
      { body: HEART },
      { body: directiveMarker("x"), author: "a" },
    ]);
    expect(out).toBe("");
  });
});

// ---------- full handoff assembly (mirrors handoff-builder.test.sh cases) ----------

describe("buildHandoff", () => {
  it("case1: directive + narrative → both channels, correct section order", () => {
    const envA = makeEnvelope("blocked", "wTEST", "2m5s", 1, "first attempt halted on parser");
    const out = buildHandoff({
      issue: 42,
      title: "Test issue",
      body: "Issue body here",
      runner: "claude",
      started: "t",
      attempt: 2,
      url: "https://github.com/x/y/issues/42",
      comments: [
        { author: "agent", createdAt: "2026-05-18T10:00:00Z", body: envA },
        { author: "alice", createdAt: "2026-05-18T10:30:00Z", body: directiveMarker("keep foo, just deprecate it") },
        { author: "bob", createdAt: "2026-05-18T10:35:00Z", body: "the parser needs to handle empty bodies" },
      ],
    });

    expect(out).toContain("<issue-body>");
    expect(out).toContain("</issue-body>");
    expect(out).toContain("Issue body here");
    expect(out).toContain("<previous-attempts>");
    expect(out).toContain('<previous-attempt n="1"');
    expect(out).toContain('status="blocked"');
    expect(out).toContain("first attempt halted on parser");
    expect(out).toContain("<human-guidance-thread>");
    expect(out).toContain('<human-guidance author="@alice"');
    expect(out).toContain("</human-guidance>");
    expect(out).toContain("keep foo, just deprecate it");
    expect(out).toContain("<thread-discussion>");
    expect(out).toContain('<thread-discussion-entry author="@bob"');
    expect(out).toContain("the parser needs to handle empty bodies");
    expect(out).toContain("<agent-notes>");
    expect(out).toContain("</agent-notes>");
    // no legacy markdown headers
    expect(out).not.toContain("## Brief");
    expect(out).not.toContain("## Notes");
    // exactly one of each channel element
    expect(out.match(/^<human-guidance author=/gm)).toHaveLength(1);
    expect(out.match(/^<thread-discussion-entry author=/gm)).toHaveLength(1);
    // thread-discussion sits after human-guidance-thread, before agent-notes
    expect(out.indexOf("<human-guidance-thread>")).toBeLessThan(out.indexOf("<thread-discussion>"));
    expect(out.indexOf("<thread-discussion>")).toBeLessThan(out.indexOf("<agent-notes>"));
  });

  it("case2: one comment with two markers → two human-guidance siblings, no discussion", () => {
    const body = `${directiveMarker("first directive")}\n\nchatter\n\n${directiveMarker("second directive")}`;
    const out = buildHandoff({
      issue: 7,
      title: "Two markers",
      body: "body",
      runner: "claude",
      started: "t",
      attempt: 2,
      url: "url",
      comments: [{ author: "carol", createdAt: "2026-05-18T11:00:00Z", body }],
    });
    expect(out.match(/^<human-guidance author=/gm)).toHaveLength(2);
    expect(out).toContain("first directive");
    expect(out).toContain("second directive");
    expect(out).not.toContain("<thread-discussion>");
    expect(out.indexOf("first directive")).toBeLessThan(out.indexOf("second directive"));
  });

  it("case3: audit-noise only → neither channel wrapper, noise dropped", () => {
    const out = buildHandoff({
      issue: 1,
      title: "Noise",
      body: "body",
      runner: "claude",
      started: "t",
      attempt: 1,
      url: "url",
      comments: [{ body: BOOT }, { body: PROMO }, { body: HEART }],
    });
    expect(out).not.toContain("<human-guidance-thread>");
    expect(out).not.toContain("<thread-discussion>");
    expect(out).not.toContain("/afk started");
    expect(out).not.toContain("promoted to ready-for-agent");
    expect(out).not.toContain(":two:");
  });

  it("case3b: noise + directive → human-guidance present, noise dropped, no discussion", () => {
    const out = buildHandoff({
      issue: 1,
      title: "Noise+dir",
      body: "body",
      runner: "claude",
      started: "t",
      attempt: 1,
      url: "url",
      comments: [{ body: BOOT }, { author: "alice", body: directiveMarker("real authoritative guidance") }],
    });
    expect(out).toContain("real authoritative guidance");
    expect(out).toContain("<human-guidance-thread>");
    expect(out).not.toContain("<thread-discussion>");
    expect(out).not.toContain("/afk started");
  });

  it("case4: zero comments → only issue-body and agent-notes", () => {
    const out = base({ title: "Empty" });
    expect(out).toContain("<issue-body>");
    expect(out).not.toContain("<previous-attempts>");
    expect(out).not.toContain("<human-guidance-thread>");
    expect(out).not.toContain("<thread-discussion>");
    expect(out).toContain("<agent-notes>");
  });

  it("exit protocol is delivered as a system prompt, NOT baked into the handoff body", () => {
    const out = base({ title: "Anything" });
    // The contract now rides RunAgentInput.systemPrompt (red-castle delivers it
    // per-CLI), so the handoff body is back to pure issue data — no footer.
    expect(out).not.toContain("<exit-protocol>");
    expect(out).toContain("<agent-notes>");
  });

  it("EXIT_PROTOCOL constant still carries the sentinel contract + already-done short-circuit", () => {
    expect(EXIT_PROTOCOL).toContain("<exit-protocol>");
    expect(EXIT_PROTOCOL).toContain("<promise>DONE</promise>");
    expect(EXIT_PROTOCOL).toContain("<promise>BLOCKED</promise>");
    expect(EXIT_PROTOCOL).toContain("ALREADY-DONE SHORT-CIRCUIT");
    expect(EXIT_PROTOCOL).toContain("prose");
  });

  it("case5: malformed envelope → no previous-attempts, no human-guidance, surfaces in discussion", () => {
    const out = buildHandoff({
      issue: 1,
      title: "Mal",
      body: "body",
      runner: "claude",
      started: "t",
      attempt: 1,
      url: "url",
      comments: [
        { author: "agent", body: ENV_NOSTATUS },
        { author: "alice", body: "please retry when you can" },
      ],
    });
    expect(out).not.toContain("<previous-attempts>");
    expect(out).not.toContain("<human-guidance-thread>");
    expect(out).toContain("<thread-discussion>");
    expect(out).toContain("boring");
    expect(out).toContain("please retry when you can");
  });

  it("header carries source/runner/started/attempt, and prd line when given", () => {
    const out = buildHandoff({
      issue: 9,
      title: "Hdr",
      body: "b",
      runner: "codex",
      started: "2026-05-30T01:02:03Z",
      attempt: 3,
      url: "https://gh/i/9",
      comments: [],
      prdRef: "244",
    });
    expect(out).toContain("# Issue #9 — Hdr [AFK]");
    expect(out).toContain("source: https://gh/i/9");
    expect(out).toContain("prd: #244");
    expect(out).toContain("runner: codex");
    expect(out).toContain("started: 2026-05-30T01:02:03Z");
    expect(out).toContain("attempt: 3");
  });

  it("omits the prd line when no prdRef", () => {
    expect(base({})).not.toContain("prd:");
  });
});

// ---------- restart-informed retry (mirrors restart-informed-retry.test.sh) ----------

describe("buildHandoff prior-attempt-context", () => {
  const priorBlock = [
    "prev-attempt: 1",
    "prev-snapshot-branch: afk-attempts/wTEST/255-foo",
    "prev-failure-reason:",
    "blocked: tests failed",
    "prev-fetched-ref: refs/afk/prior-attempt",
  ].join("\n");

  it("retry: emits <prior-attempt-context> with prior branch + reason", () => {
    const out = buildHandoff({
      issue: 255,
      title: "Title",
      body: "issue body",
      runner: "claude",
      started: "t",
      attempt: 2,
      url: "url",
      comments: [],
      priorAttemptContext: priorBlock,
    });
    expect(out).toContain("<prior-attempt-context>");
    expect(out).toContain("</prior-attempt-context>");
    expect(out).toContain("afk-attempts/wTEST/255-foo");
    expect(out).toContain("blocked: tests failed");
  });

  it("first attempt: empty context → element omitted entirely", () => {
    const out = buildHandoff({
      issue: 255,
      title: "Title",
      body: "issue body",
      runner: "claude",
      started: "t",
      attempt: 1,
      url: "url",
      comments: [],
      priorAttemptContext: "",
    });
    expect(out).not.toContain("<prior-attempt-context>");
  });

  it("undefined context (legacy call) → element omitted", () => {
    expect(base({})).not.toContain("<prior-attempt-context>");
  });

  it("prior-attempt-context sits after human-guidance-thread, before thread-discussion", () => {
    const out = buildHandoff({
      issue: 255,
      title: "Order",
      body: "b",
      runner: "claude",
      started: "t",
      attempt: 2,
      url: "url",
      comments: [
        { author: "alice", body: directiveMarker("do the thing") },
        { author: "bob", body: "some advisory chatter" },
      ],
      priorAttemptContext: priorBlock,
    });
    expect(out.indexOf("<human-guidance-thread>")).toBeLessThan(out.indexOf("<prior-attempt-context>"));
    expect(out.indexOf("<prior-attempt-context>")).toBeLessThan(out.indexOf("<thread-discussion>"));
  });
});
