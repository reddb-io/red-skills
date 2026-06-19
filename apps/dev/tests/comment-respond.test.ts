import { describe, expect, it } from "vitest";
import {
  runRespond,
  REVIEW_NOT_A_PR_BODY,
  type CommentEvent,
  type RespondDeps,
  type RespondGh,
  actionPushesCode,
  decideRespondAction,
  MUTATION_VERB,
  parseDevVerb,
  type CommenterTrust,
  type RespondDecision,
} from "../src/core/comment-respond.js";
import type { ActorTrustVerdict } from "../src/core/trust-gate.js";

// A recording fake `gh` reply surface — mirrors review.test.ts's injected fake.
// It exposes ONLY a reply primitive (no push/merge), so a code push is
// structurally impossible from this path.
function fakeGh(): { gh: RespondGh; replies: { number: number; body: string }[] } {
  const replies: { number: number; body: string }[] = [];
  const gh: RespondGh = {
    async reply(number, body) {
      replies.push({ number, body });
    },
  };
  return { gh, replies };
}

const TRUSTED: ActorTrustVerdict = { executable: true, basis: "write-access" };
const UNTRUSTED: ActorTrustVerdict = {
  executable: false,
  reason: "actor 'stranger' is not a repository maintainer",
};

function event(over: Partial<CommentEvent> = {}): CommentEvent {
  return { body: "", author: "maintainer", number: 750, isPr: true, runner: "opencode", ...over };
}

function deps(
  gh: RespondGh,
  over: Partial<RespondDeps> = {},
): RespondDeps {
  return {
    gh,
    resolveTrust: async () => TRUSTED,
    explain: async () => "here is the answer",
    review: async () => {},
    ...over,
  };
}

describe("runRespond — summon gate", () => {
  it("ignores a comment with no `/dev` verb and no @mention (no reply, no mutation)", async () => {
    const { gh, replies } = fakeGh();
    const result = await runRespond(deps(gh), event({ body: "just a normal comment" }));
    expect(result.action).toBe("ignored");
    expect(replies).toEqual([]);
  });
});

describe("runRespond — authorization (#747 trust resolver)", () => {
  it("refuses an untrusted commenter with a single refusal reply and nothing else", async () => {
    const { gh, replies } = fakeGh();
    let explained = false;
    let reviewed = false;
    const result = await runRespond(
      deps(gh, {
        resolveTrust: async () => UNTRUSTED,
        explain: async () => {
          explained = true;
          return "x";
        },
        review: async () => {
          reviewed = true;
        },
      }),
      event({ body: "/dev explain why", author: "stranger" }),
    );

    expect(result.action).toBe("refused");
    expect(result.reason).toContain("not a repository maintainer");
    // exactly one reply (the refusal) and no advisory work ran
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain("refused");
    expect(explained).toBe(false);
    expect(reviewed).toBe(false);
  });

  it("passes the commenter login to the trust resolver", async () => {
    const { gh } = fakeGh();
    let seen: string | undefined = "unset";
    await runRespond(
      deps(gh, {
        resolveTrust: async (actor) => {
          seen = actor;
          return TRUSTED;
        },
      }),
      event({ body: "/dev explain", author: "carol" }),
    );
    expect(seen).toBe("carol");
  });
});

describe("runRespond — advisory verb routing", () => {
  it("`/dev explain` posts the answer in-thread (no push)", async () => {
    const { gh, replies } = fakeGh();
    const result = await runRespond(
      deps(gh, { explain: async () => "CI is red because of a flaky test" }),
      event({ body: "/dev explain why is CI red", number: 742 }),
    );
    expect(result.action).toBe("explained");
    expect(result.verb).toBe("explain");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ number: 742 });
    expect(replies[0]?.body).toContain("CI is red because of a flaky test");
  });

  it("`/dev review` on a PR delegates to the advisory review path (no reply mutation here)", async () => {
    const { gh, replies } = fakeGh();
    let reviewedNumber: number | undefined;
    const result = await runRespond(
      deps(gh, { review: async (e) => { reviewedNumber = e.number; } }),
      event({ body: "/dev review", number: 742, isPr: true }),
    );
    expect(result.action).toBe("reviewed");
    expect(result.verb).toBe("review");
    expect(reviewedNumber).toBe(742);
    // the review path owns its own writes; respond posts no extra reply
    expect(replies).toEqual([]);
  });

  it("`/dev review` on an issue (not a PR) replies that review is PR-only", async () => {
    const { gh, replies } = fakeGh();
    let reviewed = false;
    const result = await runRespond(
      deps(gh, { review: async () => { reviewed = true; } }),
      event({ body: "/dev review", number: 750, isPr: false }),
    );
    expect(result.action).toBe("unsupported");
    expect(reviewed).toBe(false);
    expect(replies[0]?.body).toBe(REVIEW_NOT_A_PR_BODY);
  });

  it("an unknown `/dev` verb gets a single unsupported reply, no advisory work", async () => {
    const { gh, replies } = fakeGh();
    let explained = false;
    const result = await runRespond(
      deps(gh, { explain: async () => { explained = true; return "x"; } }),
      event({ body: "/dev frobnicate the widget" }),
    );
    expect(result.action).toBe("unsupported");
    expect(result.verb).toBe("frobnicate");
    expect(explained).toBe(false);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.body).toContain("not an available command");
  });

  it("a bare `/dev` (empty verb) is unsupported, not a crash", async () => {
    const { gh, replies } = fakeGh();
    const result = await runRespond(deps(gh), event({ body: "/dev" }));
    expect(result.action).toBe("unsupported");
    expect(replies).toHaveLength(1);
  });

  it("honours an @mention summon when a bot handle is configured", async () => {
    const { gh, replies } = fakeGh();
    const result = await runRespond(
      deps(gh, { mentions: ["red-dev"], explain: async () => "mentioned answer" }),
      event({ body: "@red-dev explain this", number: 742 }),
    );
    expect(result.action).toBe("explained");
    expect(replies[0]?.body).toContain("mentioned answer");
  });
});

// ---------------------------------------------------------------------------
// The pure decision layer (issue #752): the `/dev` verb grammar + tiered
// advisory/mutation routing that the cloud `/dev fix` push path is built on.
// ---------------------------------------------------------------------------

const TRUSTED_COMMENTER: CommenterTrust = { trusted: true };
const UNTRUSTED_COMMENTER: CommenterTrust = { trusted: false, reason: "not a repository maintainer" };

describe("parseDevVerb — the /dev summon grammar", () => {
  it("parses a fix verb and its multi-line instruction", () => {
    const parsed = parseDevVerb("/dev fix tighten the null guard\nin the parser");
    expect(parsed).toEqual({ verb: "fix", instruction: "tighten the null guard\nin the parser" });
  });

  it("parses an advisory verb with an empty instruction", () => {
    expect(parseDevVerb("/dev explain")).toEqual({ verb: "explain", instruction: "" });
  });

  it("recognises the summon only on the first non-blank line, ignoring leading blanks", () => {
    expect(parseDevVerb("\n\n   /dev review please")).toEqual({ verb: "review", instruction: "please" });
  });

  it("is case-insensitive on the /dev prefix and the verb", () => {
    expect(parseDevVerb("/DEV Fix do the thing")).toEqual({ verb: "fix", instruction: "do the thing" });
  });

  it("returns null for an unknown verb", () => {
    expect(parseDevVerb("/dev frobnicate the widget")).toBeNull();
  });

  it("returns null when there is no /dev prefix", () => {
    expect(parseDevVerb("just a normal human comment about fix")).toBeNull();
  });

  it("returns null for a blank body", () => {
    expect(parseDevVerb("   \n\t\n")).toBeNull();
  });

  it("does not treat a mid-line /dev as a summon", () => {
    expect(parseDevVerb("please run /dev fix for me")).toBeNull();
  });
});

describe("decideRespondAction — tiered mutation routing", () => {
  it("trusted /dev fix routes to the mutation path (the one push surface)", () => {
    const action = decideRespondAction("/dev fix patch the bug", TRUSTED_COMMENTER);
    expect(action).toEqual({ kind: "mutate", instruction: "patch the bug" });
    expect(actionPushesCode(action)).toBe(true);
  });

  it("untrusted /dev fix is refused with no push", () => {
    const action = decideRespondAction("/dev fix patch the bug", UNTRUSTED_COMMENTER);
    expect(action.kind).toBe("refuse");
    if (action.kind === "refuse") {
      expect(action.reason).toContain("not a repository maintainer");
    }
    expect(actionPushesCode(action)).toBe(false);
  });

  it("trusted advisory verbs never push", () => {
    for (const verb of ["explain", "review", "triage"] as const) {
      const action = decideRespondAction(`/dev ${verb} something`, TRUSTED_COMMENTER);
      expect(action.kind).toBe("advisory");
      expect(actionPushesCode(action)).toBe(false);
    }
  });

  it("untrusted advisory verbs are refused, not pushed", () => {
    const action = decideRespondAction("/dev review the diff", UNTRUSTED_COMMENTER);
    expect(action.kind).toBe("refuse");
    expect(actionPushesCode(action)).toBe(false);
  });

  it("a non-/dev comment is ignored — never pushes", () => {
    const action = decideRespondAction("nice work on this PR!", TRUSTED_COMMENTER);
    expect(action).toEqual({ kind: "ignore" });
    expect(actionPushesCode(action)).toBe(false);
  });

  it("an unknown verb is ignored even from a trusted commenter", () => {
    const action = decideRespondAction("/dev deploy to prod", TRUSTED_COMMENTER);
    expect(action).toEqual({ kind: "ignore" });
  });

  it("mutate is the ONLY action kind that reports as code-pushing", () => {
    const samples: RespondDecision[] = [
      { kind: "ignore" },
      { kind: "refuse", reason: "x" },
      { kind: "advisory", verb: "explain", instruction: "" },
      { kind: "mutate", instruction: "y" },
    ];
    expect(samples.filter(actionPushesCode)).toEqual([{ kind: "mutate", instruction: "y" }]);
  });

  it("the mutation verb constant is `fix`", () => {
    expect(MUTATION_VERB).toBe("fix");
  });
});
