// The demand loop only runs on a daemon that can ask (#2908).
//
// `serve` held the loop and the poller as options nothing on the shipped path
// ever set, so a machine running the real binary registered projects, counted no
// queue, and birthed nothing — while every in-process test of the loop stayed
// green. This pins the wiring itself: what arms the poller, what leaves it
// unarmed, and where it asks.
//
// **No token, no poller — and no invented depth.** A daemon that cannot reach
// the tracker holds registrations it never counts, which reads as `queue-unknown`
// at every tick. That is the honest state, and it is distinguishable from a
// drained queue, which is the distinction the whole amendment turns on.
import { describe, expect, it } from "vitest";
import { REDSKILLED_HOST_TOKEN_ENV, resolveServeQueueDiscovery } from "../src/cli.js";

describe("`redskilled serve` arms the queue poller", () => {
  it("builds a transport from the host token", () => {
    const armed = resolveServeQueueDiscovery({}, { [REDSKILLED_HOST_TOKEN_ENV]: "t" });

    expect(armed?.transport).toBeTypeOf("function");
  });

  it("leaves the poller unarmed when no token names a credential", () => {
    expect(resolveServeQueueDiscovery({}, {})).toBeUndefined();
    expect(resolveServeQueueDiscovery({}, { [REDSKILLED_HOST_TOKEN_ENV]: "   " })).toBeUndefined();
  });

  it("falls back to the tracker's own token variables", () => {
    // One token per host by construction: quota is per credential, so the point
    // of batching is lost the moment a second one appears.
    expect(resolveServeQueueDiscovery({}, { GITHUB_TOKEN: "t" })).toBeDefined();
    expect(resolveServeQueueDiscovery({}, { GH_TOKEN: "t" })).toBeDefined();
  });

  it("carries the window a caller stated, and states none when it did not", () => {
    expect(
      resolveServeQueueDiscovery({ "queue-ms": 300 }, { [REDSKILLED_HOST_TOKEN_ENV]: "t" })?.intervalMs,
    ).toBe(300);
    expect(resolveServeQueueDiscovery({}, { [REDSKILLED_HOST_TOKEN_ENV]: "t" })?.intervalMs).toBeUndefined();
  });

  it("asks where the flag says, and the flag outranks the environment", async () => {
    // The endpoint is what makes the shipped transport provable without GitHub:
    // the daemon really issues its aliased query over a socket and really parses
    // an answer, with only the tracker standing in.
    const asked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const armed = resolveServeQueueDiscovery(
        { "queue-endpoint": "http://127.0.0.1:1/graphql" },
        { [REDSKILLED_HOST_TOKEN_ENV]: "t", GITHUB_GRAPHQL_URL: "http://elsewhere/graphql" },
      );
      await armed!.transport!("query {}");
    } finally {
      globalThis.fetch = original;
    }

    expect(asked).toEqual(["http://127.0.0.1:1/graphql"]);
  });
});
