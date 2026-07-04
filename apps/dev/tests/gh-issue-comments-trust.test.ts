import { describe, expect, it } from "vitest";
import { issueComments, type GhContext } from "../src/runtime/gh.js";
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

const COMMENTS = JSON.stringify({
  comments: [
    { body: "bot chatter", author: { login: "dependabot", is_bot: true }, authorAssociation: "NONE" },
    { body: "owner order", author: { login: "maint", is_bot: false }, authorAssociation: "OWNER" },
    { body: "collab order", author: { login: "friend", is_bot: false }, authorAssociation: "COLLABORATOR" },
    { body: "stranger order", author: { login: "stranger", is_bot: false }, authorAssociation: "NONE" },
    { body: "allowlisted order", author: { login: "trusted-ext", is_bot: false }, authorAssociation: "CONTRIBUTOR" },
  ],
});

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
