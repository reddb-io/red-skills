import { beforeEach, describe, expect, it } from "vitest";
import type { GithubClient } from "@reddb-io/github";
import type { GhContext } from "../src/runtime/gh.js";
// The reset is a test-only seam; the barrel keeps its published surface.
import { actorTrustSignals, resetCodeownersCache } from "../src/runtime/gh/trust.js";

/** A routed client that answers 404 for every CODEOWNERS location and counts
 * the asks, plus a permission read so the parallel signal resolves. */
function countingClient(seen: string[]): GithubClient {
  return {
    conditionalRest: async (request: { parameters?: Record<string, unknown> }) => {
      const path = String(request.parameters?.path ?? "");
      if (path !== "") {
        seen.push(path);
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return { data: { permission: "write" }, headers: {}, quotaFree: false, requestCount: 1 };
    },
    conditionalPaginate: async () => { throw new Error("unexpected conditionalPaginate"); },
    graphql: async () => { throw new Error("unexpected graphql"); },
    singleObject: async () => { throw new Error("unexpected singleObject"); },
  } as unknown as GithubClient;
}

function context(github: GithubClient): GhContext {
  return { repo: "acme/widgets", cwd: "/tmp", github } as GhContext;
}

describe("CODEOWNERS resolution is a repository fact", () => {
  beforeEach(() => {
    resetCodeownersCache();
  });

  it("reads the recognised locations once, however many actors are judged", async () => {
    const seen: string[] = [];
    const ctx = context(countingClient(seen));

    for (const actor of ["ana", "bruno", "carol", "dan"]) {
      const signals = await actorTrustSignals(ctx, actor);
      expect(signals.inCodeowners).toBe(false);
    }

    // Four actors, one repository: the trust gate asked per candidate and a
    // boot listing 14 of them paid three 404s each.
    expect(seen).toEqual([".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]);
  });

  it("never caches an unavailable signal, so one blip cannot poison the process", async () => {
    let failNext = true;
    const seen: string[] = [];
    const github = {
      conditionalRest: async (request: { parameters?: Record<string, unknown> }) => {
        const path = String(request.parameters?.path ?? "");
        if (path === "") return { data: { permission: "read" }, headers: {}, quotaFree: false, requestCount: 1 };
        seen.push(path);
        if (failNext) throw Object.assign(new Error("bad gateway"), { status: 502 });
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
      conditionalPaginate: async () => { throw new Error("unexpected conditionalPaginate"); },
      graphql: async () => { throw new Error("unexpected graphql"); },
      singleObject: async () => { throw new Error("unexpected singleObject"); },
    } as unknown as GithubClient;
    const ctx = context(github);

    expect((await actorTrustSignals(ctx, "ana")).inCodeowners).toBeUndefined();
    failNext = false;
    expect((await actorTrustSignals(ctx, "ana")).inCodeowners).toBe(false);
    expect(seen.length).toBeGreaterThan(1);
  });
});
