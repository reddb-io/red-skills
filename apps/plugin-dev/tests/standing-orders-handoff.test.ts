// The standing-orders front of Spec #4129, Ticket #4141: a durable maintainer
// directive is a mandatory verbatim section of the handoff, and the exit
// protocol's authority sentence NAMES it — because a guard that lists exactly
// two authoritative sources, while the handoff carries a third, teaches the
// agent that its own standing orders are the kind of text it was told to ignore.
//
// Both states are pinned as snapshots, and the second one is the load-bearing
// half: a repository that never wrote the file must get the handoff and the
// protocol it got before this landed, byte for byte.
import { describe, expect, it } from "vitest";
import {
  AUTHORITY_SENTENCE,
  AUTHORITY_SENTENCE_WITH_STANDING_ORDERS,
  EXIT_PROTOCOL,
  SCOUT_EXIT_PROTOCOL,
  buildHandoff,
  exitProtocolFor,
} from "../src/core/handoff.js";

const ORDERS = [
  "1. Never hand-edit the generated Codex or Gemini manifests; regenerate them.",
  "2. Land through the daemon. `git push` to main is never the answer.",
].join("\n");

function handoff(overrides: Partial<Parameters<typeof buildHandoff>[0]> = {}) {
  return buildHandoff({
    issue: 4141,
    title: "Standing orders",
    body: "## Acceptance criteria\n\n- [ ] `pnpm typecheck` is green",
    runner: "claude",
    started: "2026-08-21T00:00:00Z",
    attempt: 1,
    url: "https://github.com/reddb-io/red-skills/issues/4141",
    comments: [],
    ...overrides,
  });
}

describe("the handoff carries the standing orders verbatim, in their own section", () => {
  it("emits <standing-orders> ahead of every untrusted section", () => {
    const out = handoff({ standingOrders: ORDERS });

    expect(out).toContain(`<standing-orders>\n${ORDERS}\n</standing-orders>`);
    // Ahead of the issue body: an order read after the brief is an order read
    // after the agent already decided how to work.
    expect(out.indexOf("<standing-orders>")).toBeLessThan(out.indexOf("<issue-body"));
    // It is the operator's own words, so it is NOT tagged as external data.
    expect(out).not.toContain('<standing-orders data-untrusted="true">');
    expect(out).toMatchSnapshot();
  });

  it("keeps the maintainer's text exactly, without renumbering or summarising", () => {
    const awkward = "  keep    the double  spaces\nand the second line";
    expect(handoff({ standingOrders: awkward })).toContain(
      `<standing-orders>\n${awkward}\n</standing-orders>`,
    );
  });

  it("omits the section when the project states no orders", () => {
    const absent = handoff();
    const disabled = handoff({ standingOrders: "" });
    const blank = handoff({ standingOrders: "   \n  " });

    expect(absent).not.toContain("standing-orders");
    expect(disabled).toBe(absent);
    expect(blank).toBe(absent);
    expect(absent).toMatchSnapshot();
  });
});

describe("the exit-protocol authority sentence names the section, and only then", () => {
  it("amends the sentence when the handoff carries orders", () => {
    const protocol = exitProtocolFor({ standingOrders: true });

    expect(protocol).toContain(AUTHORITY_SENTENCE_WITH_STANDING_ORDERS);
    expect(protocol).not.toContain(AUTHORITY_SENTENCE);
    expect(protocol).toContain("<standing-orders>");
    expect(protocol).toMatchSnapshot();
  });

  it("leaves the sentence and the whole protocol unchanged when there are none", () => {
    expect(exitProtocolFor({})).toBe(EXIT_PROTOCOL);
    expect(exitProtocolFor({ standingOrders: false })).toBe(EXIT_PROTOCOL);
    expect(EXIT_PROTOCOL).toContain(AUTHORITY_SENTENCE);
    expect(EXIT_PROTOCOL).not.toContain("standing-orders");
    expect(EXIT_PROTOCOL).toMatchSnapshot();
  });

  it("amends the scout protocol the same way, since it carries the same guard", () => {
    expect(exitProtocolFor({ runMode: "scout" })).toBe(SCOUT_EXIT_PROTOCOL);
    expect(exitProtocolFor({ runMode: "scout", standingOrders: true }))
      .toContain(AUTHORITY_SENTENCE_WITH_STANDING_ORDERS);
  });

  it("still splices the structured-output and preflight clauses beside the amendment", () => {
    const protocol = exitProtocolFor({
      structuredOutput: true,
      preflightCommands: ["pnpm typecheck"],
      standingOrders: true,
    });

    expect(protocol).toContain("<agent-output>");
    expect(protocol).toContain("<preflight>");
    expect(protocol).toContain(AUTHORITY_SENTENCE_WITH_STANDING_ORDERS);
  });

  it("points the agent at the file the orders came from", () => {
    expect(AUTHORITY_SENTENCE_WITH_STANDING_ORDERS).toContain(".red/STANDING-ORDERS.md");
  });
});
