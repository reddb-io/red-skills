import { describe, expect, it } from "vitest";

import {
  DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
  GITHUB_REQUEST_TIMEOUT_ENV,
  GithubTimeoutError,
  createTimedGithubFetch,
  githubRequestTimeoutMs,
  isGithubTimeoutError,
  withGithubDeadline,
} from "./deadline.js";

const never = new Promise<never>(() => undefined);

describe("the request bound this process runs under", () => {
  it("is the documented default when the operator declared nothing", () => {
    expect(githubRequestTimeoutMs({})).toBe(DEFAULT_GITHUB_REQUEST_TIMEOUT_MS);
  });

  it("honours a declared override", () => {
    expect(githubRequestTimeoutMs({ [GITHUB_REQUEST_TIMEOUT_ENV]: "1500" })).toBe(1_500);
  });

  it("ignores a malformed override rather than bricking every read", () => {
    expect(githubRequestTimeoutMs({ [GITHUB_REQUEST_TIMEOUT_ENV]: "soon" }))
      .toBe(DEFAULT_GITHUB_REQUEST_TIMEOUT_MS);
    expect(githubRequestTimeoutMs({ [GITHUB_REQUEST_TIMEOUT_ENV]: "-5" }))
      .toBe(DEFAULT_GITHUB_REQUEST_TIMEOUT_MS);
  });
});

describe("a fetch that never answers", () => {
  it("becomes a bounded, named error instead of a forever", async () => {
    const timed = createTimedGithubFetch({ timeoutMs: 25, fetchImpl: async () => await never });
    const startedAt = Date.now();

    const error = await timed("https://api.github.com/repos/acme/widgets/issues/7")
      .then(() => null, (thrown: unknown) => thrown);

    expect(isGithubTimeoutError(error)).toBe(true);
    expect((error as GithubTimeoutError).timeoutMs).toBe(25);
    expect(String(error)).toContain("/repos/acme/widgets/issues/7");
    expect(String(error)).toContain(GITHUB_REQUEST_TIMEOUT_ENV);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("aborts the transport rather than merely abandoning it", async () => {
    let observed: AbortSignal | undefined;
    const timed = createTimedGithubFetch({
      timeoutMs: 25,
      fetchImpl: async (_input, init) => {
        observed = init?.signal ?? undefined;
        return await never;
      },
    });

    await timed("https://api.github.com/rate_limit").catch(() => undefined);

    expect(observed?.aborted).toBe(true);
  });

  it("never renames a caller's own cancellation as a timeout", async () => {
    const controller = new AbortController();
    const timed = createTimedGithubFetch({
      timeoutMs: 10_000,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new Error("caller aborted"));
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener("abort", abort);
        }),
    });

    const pending = timed("https://api.github.com/rate_limit", { signal: controller.signal });
    controller.abort();
    const error = await pending.then(() => null, (thrown: unknown) => thrown);

    expect(isGithubTimeoutError(error)).toBe(false);
    expect(String(error)).toContain("caller aborted");
  });

  it("leaves the bound off entirely when the operator disabled it", async () => {
    const answer = new Response("{}", { status: 200 });
    const timed = createTimedGithubFetch({ timeoutMs: 0, fetchImpl: async () => answer });
    await expect(timed("https://api.github.com/rate_limit")).resolves.toBe(answer);
  });
});

describe("a joiner waiting on someone else's promise", () => {
  it("inherits its own deadline rather than the leader's patience", async () => {
    const startedAt = Date.now();

    const error = await withGithubDeadline("balance ask", 25, () => never)
      .then(() => null, (thrown: unknown) => thrown);

    expect(isGithubTimeoutError(error)).toBe(true);
    expect(String(error)).toContain("balance ask");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("returns the answer untouched when it arrives in time", async () => {
    await expect(withGithubDeadline("balance ask", 5_000, async () => 41 + 1)).resolves.toBe(42);
  });

  it("passes a genuine failure through as itself", async () => {
    const boom = new Error("GitHub refused with HTTP 401");
    await expect(withGithubDeadline("balance ask", 5_000, async () => {
      throw boom;
    })).rejects.toBe(boom);
  });
});
