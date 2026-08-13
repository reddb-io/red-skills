import { describe, expect, it } from "vitest";
import { issueComments, type GhContext } from "../src/runtime/gh.js";
import { classifySourceTrust } from "../src/core/source-trust.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import type { ActorTrustVerdict } from "../src/core/trust-gate.js";

/**
 * Source-trust classification for the guidance channel (issue #1100). The comment
 * projection resolves a source-trust LEVEL for every comment so guidance
 * promotion can gate on SOURCE, never directive FORMAT. These pin:
 *   - a bot author → automation (no trust lookup),
 *   - an OWNER/MEMBER/COLLABORATOR association → trusted (no trust lookup),
 *   - a non-collaborator with no override → dubious,
 *   - a non-collaborator promoted through the injected `resolveActorTrust`.
 */

function ghReturning(stdout: string, code = 0): GhContext {
  const out: ExecOutput = { code, stdout, stderr: "" };
  const exec: ExecFn = () => Promise.resolve(out);
  return { cwd: "/r", repo: "acme/widgets", exec };
}

/** One raw REST comment row, the shape the paginated read actually returns. */
const restComment = (body: string, login: string, association: string, bot = false) => ({
  body,
  user: { login, type: bot ? "Bot" : "User" },
  author_association: association,
  created_at: "2026-08-13T00:00:00Z",
});

// The fixture used to answer `{comments: […]}` — the projection a hand-rolled
// jq pipeline was meant to produce. That argv was refused by `gh`, so the shape
// never existed outside this file (#3734).
const COMMENTS = JSON.stringify([
  restComment("bot chatter", "dependabot", "NONE", true),
  restComment("owner order", "maint", "OWNER"),
  restComment("collab order", "friend", "COLLABORATOR"),
  restComment("stranger order", "stranger", "NONE"),
  restComment("allowlisted order", "trusted-ext", "CONTRIBUTOR"),
]);

describe("issueComments — source-trust projection (#1100)", () => {
  it("classifies bots as automation and trusted associations as trusted without a lookup", async () => {
    let lookups = 0;
    const resolveTrust = async (): Promise<ActorTrustVerdict> => {
      lookups += 1;
      return { executable: false, reason: "unused" };
    };
    const out = await issueComments(ghReturning(COMMENTS), 7, resolveTrust);

    expect(out[0]).toMatchObject({ author: "dependabot", sourceTrust: "automation" });
    expect(out[1]).toMatchObject({ author: "maint", sourceTrust: "trusted" });
    expect(out[2]).toMatchObject({ author: "friend", sourceTrust: "trusted" });
    // only the two non-collaborators (stranger, trusted-ext) needed a lookup.
    expect(lookups).toBe(2);
  });

  it("resolves a non-collaborator through the injected trust primitive", async () => {
    const resolveTrust = async (actor: string): Promise<ActorTrustVerdict> =>
      actor === "trusted-ext"
        ? { executable: true, basis: "allowlist" }
        : { executable: false, reason: "not a maintainer" };
    const out = await issueComments(ghReturning(COMMENTS), 7, resolveTrust);

    expect(out[3]).toMatchObject({ author: "stranger", sourceTrust: "dubious" });
    expect(out[4]).toMatchObject({ author: "trusted-ext", sourceTrust: "trusted" });
  });

  it("does not promote an outside comment on a reaction — that rule is gone", () => {
    // A maintainer's 👍 on one comment used to promote that comment alone,
    // precedence rule 4 of 5. It never fired: the field it read was supplied by
    // NO reader in the repository, and the REST payload carries reaction counts
    // without the reacting logins. The rule and its field are deleted rather
    // than left dangling; restoring the capability needs a per-comment
    // `…/comments/{id}/reactions` read, which is an N+1 on a budget-aware
    // client and a decision to take deliberately.
    const input = { authorAssociation: "NONE", isBot: false } as Parameters<typeof classifySourceTrust>[0];
    expect(classifySourceTrust({ ...input, maintainerThumbsUp: true } as never)).toBe("dubious");
  });

  it("without a resolver a non-collaborator falls to dubious", async () => {
    const out = await issueComments(ghReturning(COMMENTS), 7);
    expect(out[3]).toMatchObject({ author: "stranger", sourceTrust: "dubious" });
    expect(out[4]).toMatchObject({ author: "trusted-ext", sourceTrust: "dubious" });
  });

  it("a failed gh read yields no comments", async () => {
    const out = await issueComments(ghReturning("", 1), 7);
    expect(out).toEqual([]);
  });
});
