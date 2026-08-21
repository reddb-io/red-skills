/**
 * Entry point `afk-lifecycle-landing`: `doLanding` refuses a head nothing
 * judged (Ticket #4138, Spec #4129, ADR 0154).
 *
 * Its verdict source, stated in `LAND_ENTRY_POINTS`, is the head this landing
 * is about to merge — the pinned `validatedBranchTip` when the caller has one,
 * otherwise the freshly resolved remote tip — so the tests below assert the
 * SUBJECT the gate was asked about, not merely that a gate was called. A
 * precondition that refuses correctly while asking about the wrong head is the
 * failure this ticket exists to close, wearing a green suite.
 */
import { describe, expect, it } from "vitest";
import type { LandSubject, LandVerdictGate } from "@reddb-io/shared/land-verdict.js";
import { DEFAULT_BRANCH_TIP, doLanding, harness } from "./landing.test-support.js";

const VALIDATED = "1111111111111111111111111111111111111111";

function gate(
  answer: (subject: LandSubject) => Awaited<ReturnType<LandVerdictGate["check"]>>,
  asked: LandSubject[] = [],
): { gate: LandVerdictGate; asked: LandSubject[] } {
  return {
    asked,
    gate: {
      check: async (subject) => {
        asked.push(subject);
        return answer(subject);
      },
    },
  };
}

const passes = () =>
  gate(() => ({
    allowed: true,
    matchedBy: "head-sha",
    verdict: "test-verified",
    identity: "codex:gpt-5",
  }));

const refuses = (reason: "no-verdict" | "stale-verdict" = "no-verdict") =>
  gate(() => ({ allowed: false, reason, message: `refused: ${reason}` }));

describe("doLanding requires a fresh verdict (#4138)", () => {
  it("lands unchanged when no gate is wired", async () => {
    const h = harness({ locked: false });
    const r = await doLanding(h.deps, h.input, h.hooks);
    expect(r.ok).toBe(true);
  });

  it("refuses `unverified-head` and carries the gate's refusal verbatim", async () => {
    const h = harness({ locked: false });
    const wired = refuses();
    h.deps.verdictGate = wired.gate;
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unverified-head");
    expect(r.message).toBe("refused: no-verdict");
  });

  it("asks about the freshly resolved remote tip when the caller pinned none", async () => {
    const h = harness({ locked: false });
    const wired = passes();
    h.deps.verdictGate = wired.gate;
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(true);
    expect(wired.asked).toEqual([{ kind: "head", headSha: DEFAULT_BRANCH_TIP }]);
  });

  it("asks about the VALIDATED tip when the caller pinned one", async () => {
    const h = harness({ locked: false });
    const wired = passes();
    h.deps.verdictGate = wired.gate;
    const r = await doLanding(h.deps, { ...h.input, validatedBranchTip: DEFAULT_BRANCH_TIP }, h.hooks);

    expect(r.ok).toBe(true);
    expect(wired.asked).toEqual([{ kind: "head", headSha: DEFAULT_BRANCH_TIP }]);
  });

  it("refuses a stale HEAD before it ever asks about a verdict", async () => {
    const h = harness({ locked: false });
    const wired = passes();
    h.deps.verdictGate = wired.gate;
    const r = await doLanding(h.deps, { ...h.input, validatedBranchTip: VALIDATED }, h.hooks);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("stale-head");
    // The head is wrong; asking who judged it would answer a question about a
    // tree this landing was never going to merge.
    expect(wired.asked).toEqual([]);
  });

  it("refuses before the pre_merge hook fires — nothing observes an unjudged landing", async () => {
    const h = harness({ locked: false });
    const wired = refuses("stale-verdict");
    h.deps.verdictGate = wired.gate;
    const fired: string[] = [];
    h.deps.fireHook = async (name) => {
      fired.push(name);
      return true;
    };
    const r = await doLanding(h.deps, h.input, h.hooks);

    expect(r.ok).toBe(false);
    expect(fired).toEqual([]);
  });
});
