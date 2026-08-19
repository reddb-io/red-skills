/**
 * The SHIPPED gh path applies quota backoff (issue #2800).
 *
 * `tests/landing-quota.test.ts` proves the primitive works when handed a
 * `quotaBackoff` option. That is exactly what made the defect invisible: the
 * only populator in the whole tree was that test, both call boundaries took a
 * bypass branch, and a live drain hit `0/5000` with no wait and no retry.
 *
 * So every case here builds the context the way the shipped binary does — NO
 * `quotaBackoff` injected — and asserts on behavior. Nothing is mocked: the
 * timings come from the operator env knobs the production defaults already read,
 * so the wiring under test is the real one, only faster.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGh, type GhContext } from "../src/runtime/gh/common.js";
import { ghAuthenticated } from "../src/runtime/gh/auth.js";
import { mergeExec, type GitContext } from "../src/runtime/git.js";
import {
  CAP_MS_ENV,
  DEFAULT_CAP_MS,
  DEFAULT_WAIT_MS,
  WAIT_MS_ENV,
  defaultGhQuotaBackoff,
  readQuotaMsEnv,
  resolveGhQuotaBackoff,
} from "../src/runtime/gh/quota.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

const RATE_LIMITED: ExecOutput = {
  code: 1,
  stdout: "",
  stderr: "HTTP 403: API rate limit exceeded for user ID 4242",
};
const SECONDARY_LIMITED: ExecOutput = {
  code: 1,
  stdout: "",
  stderr: "HTTP 403: You have triggered an abuse detection mechanism.",
};
const OK: ExecOutput = { code: 0, stdout: "done", stderr: "" };

/** An ExecFn draining `responses` in order, recording every invocation. */
function queuedExec(responses: readonly ExecOutput[]): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return responses[index++] ?? OK;
  };
  return { exec, calls };
}

/** Every `quota-wait` line the run wrote to stderr. */
let notices: string[];

beforeEach(() => {
  notices = [];
  // Real waits, 1ms each, with a budget wide enough for several retries: the
  // production code path runs unchanged, it just does not take a minute.
  process.env[WAIT_MS_ENV] = "1";
  process.env[CAP_MS_ENV] = "1000";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    notices.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  delete process.env[WAIT_MS_ENV];
  delete process.env[CAP_MS_ENV];
  vi.restoreAllMocks();
});

describe("runGh applies quota backoff with no option injected (#2800)", () => {
  it("waits and retries a primary rate limit, then returns the success", async () => {
    const { exec, calls } = queuedExec([RATE_LIMITED, OK]);
    // The shipped context shape: repo, cwd, exec seam — and NO quotaBackoff.
    const ctx: GhContext = { repo: "acme/widgets", cwd: "/repo", exec };

    const result = await runGh(ctx, ["issue", "comment", "42", "--body", "hi"]);

    expect(result).toEqual(OK);
    expect(calls.length).toBe(2);
    // The wait announced itself rather than presenting as silence.
    expect(notices.join("")).toContain("quota-wait");
  });

  it("waits and retries a secondary/abuse limit too", async () => {
    const { exec, calls } = queuedExec([SECONDARY_LIMITED, OK]);

    const result = await runGh({ repo: "acme/widgets", cwd: "/repo", exec }, ["pr", "list"]);

    expect(result).toEqual(OK);
    expect(calls.length).toBe(2);
  });

  it("retries a GraphQL RATE_LIMITED body", async () => {
    const graphqlLimited: ExecOutput = {
      code: 1,
      stdout: JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limited" }] }),
      stderr: "",
    };
    const { exec, calls } = queuedExec([graphqlLimited, OK]);

    const result = await runGh({ repo: "acme/widgets", cwd: "/repo", exec }, ["api", "graphql"]);

    expect(result).toEqual(OK);
    expect(calls.length).toBe(2);
  });

  it("does NOT retry a permanent failure — auth error", async () => {
    const authError: ExecOutput = { code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" };
    const { exec, calls } = queuedExec([authError, OK]);

    const result = await runGh({ repo: "acme/widgets", cwd: "/repo", exec }, ["pr", "merge", "7"]);

    expect(result).toEqual(authError);
    expect(calls.length).toBe(1);
    expect(notices.join("")).not.toContain("quota-wait");
  });

  it("does NOT retry a permanent failure — 404", async () => {
    const notFound: ExecOutput = { code: 1, stdout: "", stderr: "HTTP 404: Not Found (issues/999)" };
    const { exec, calls } = queuedExec([notFound, OK]);

    const result = await runGh({ repo: "acme/widgets", cwd: "/repo", exec }, ["issue", "view", "999"]);

    expect(result).toEqual(notFound);
    expect(calls.length).toBe(1);
  });

  it("returns the rate-limit response once the cap is exhausted (never loops forever)", async () => {
    process.env[CAP_MS_ENV] = "0"; // the operator kill switch: refuse the wait
    const { exec, calls } = queuedExec([RATE_LIMITED, RATE_LIMITED, OK]);

    const result = await runGh({ repo: "acme/widgets", cwd: "/repo", exec }, ["pr", "merge", "7"]);

    expect(result).toEqual(RATE_LIMITED);
    expect(calls.length).toBe(1);
  });

  it('an explicit { quota: "off" } still bypasses — the boot-probe escape hatch', async () => {
    const { exec, calls } = queuedExec([RATE_LIMITED, OK]);

    const result = await runGh({ repo: "acme/widgets", cwd: "/repo", exec }, ["auth", "status"], {
      quota: "off",
    });

    expect(result).toEqual(RATE_LIMITED);
    expect(calls.length).toBe(1);
  });

  it("the boot auth probe takes that hatch — a rate limit must not stall boot", async () => {
    const { exec, calls } = queuedExec([RATE_LIMITED, OK]);

    // Rate-limited `gh auth status` still reports authenticated (the token is
    // configured), and it does so on the FIRST call — no retry, no wait.
    expect(await ghAuthenticated({ repo: "acme/widgets", cwd: "/repo", exec })).toBe(true);
    expect(calls.length).toBe(1);
  });
});

describe("mergeExec applies quota backoff with no option injected (#2800)", () => {
  it("waits and retries a rate-limited `gh` command on the landing path", async () => {
    const { exec, calls } = queuedExec([RATE_LIMITED, OK]);
    // The shipped landing context: cwd + exec seam, NO quotaBackoff.
    const ctx: GitContext = { cwd: "/repo", exec };

    const result = await mergeExec(ctx)(["gh", "pr", "merge", "77", "--merge"]);

    expect(result.code).toBe(0);
    expect(calls.length).toBe(2);
    expect(notices.join("")).toContain("quota-wait");
  });

  it("never delays a `git`-headed command — git makes no GitHub API call", async () => {
    // A git failure whose text happens to name a rate limit must still not wait.
    const { exec, calls } = queuedExec([RATE_LIMITED, OK]);

    const result = await mergeExec({ cwd: "/repo", exec })(["git", "push", "origin", "HEAD"]);

    expect(result.code).toBe(1);
    expect(calls.length).toBe(1);
  });
});

describe("the default options are production-shaped", () => {
  it("carries the documented cap and wait, a real clock, and a quota-wait notice", () => {
    delete process.env[WAIT_MS_ENV];
    delete process.env[CAP_MS_ENV];
    const opts = defaultGhQuotaBackoff();

    expect(opts.capMs).toBe(30 * 60 * 1000);
    expect(opts.defaultWaitMs).toBe(60 * 1000);
    expect(opts.nowMs()).toBeGreaterThan(0);

    opts.onWait?.(5 * 60 * 1000);
    expect(notices.join("")).toContain("quota-wait");
  });

  it("resolves an injected option over the default, so tests keep their seam", () => {
    const injected = { nowMs: () => 7, sleepMs: async () => {}, capMs: 1, defaultWaitMs: 2 };

    expect(resolveGhQuotaBackoff(injected)).toBe(injected);
    expect(resolveGhQuotaBackoff(undefined).defaultWaitMs).toBe(1); // from WAIT_MS_ENV
  });

  it("ignores a malformed env override rather than bricking every gh call", () => {
    expect(readQuotaMsEnv(WAIT_MS_ENV, DEFAULT_WAIT_MS, { [WAIT_MS_ENV]: "soon" })).toBe(DEFAULT_WAIT_MS);
    expect(readQuotaMsEnv(CAP_MS_ENV, DEFAULT_CAP_MS, { [CAP_MS_ENV]: "-5" })).toBe(DEFAULT_CAP_MS);
    expect(readQuotaMsEnv(CAP_MS_ENV, DEFAULT_CAP_MS, {})).toBe(DEFAULT_CAP_MS);
    expect(readQuotaMsEnv(CAP_MS_ENV, DEFAULT_CAP_MS, { [CAP_MS_ENV]: "0" })).toBe(0);
  });
});
