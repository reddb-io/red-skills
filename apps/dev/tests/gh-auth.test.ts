import { describe, expect, it } from "vitest";
import { ghAuthenticated, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

/**
 * Mode B regression (AFK fast-death taxonomy): `gh auth status` exits non-zero
 * BOTH on a real missing/rejected token AND on a transient validation failure
 * (rate-limit / network / 5xx) while a valid token is still configured. The old
 * `r.code === 0` check collapsed the two — so a GitHub rate-limit burst made the
 * boot precheck report "gh not authenticated" and brick every worker respawn.
 * `ghAuthenticated` now discriminates on the report text.
 */

function execReturning(out: ExecOutput): ExecFn {
  return () => Promise.resolve(out);
}

function ctxWith(out: ExecOutput): GhContext {
  return { cwd: "/r", repo: "acme/widgets", exec: execReturning(out) };
}

describe("ghAuthenticated — rate-limit vs real auth failure", () => {
  it("exit 0 → authenticated", async () => {
    const out: ExecOutput = {
      code: 0,
      stdout: "",
      stderr: "github.com\n  ✓ Logged in to github.com account octocat\n  ✓ Token: gho_****",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(true);
  });

  it("non-zero with a definitive 'not logged in' → unauthenticated", async () => {
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(false);
  });

  it("non-zero with 'bad credentials' (rejected token) → unauthenticated", async () => {
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr: "github.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n  error: Bad credentials",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(false);
  });

  it("non-zero from an API rate-limit burst → still authenticated (token is configured)", async () => {
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr:
        "github.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n" +
        "  error validating token: API rate limit already exceeded for user ID 2805436.",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(true);
  });

  it("non-zero from a transient network/5xx blip → still authenticated", async () => {
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr: "github.com\n  X error connecting to api.github.com\n  503 Service Unavailable",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(true);
  });

  it("a real rate-limit error must NOT also trip the unauthenticated pattern", async () => {
    // Guard against the two regexes overlapping: a rate-limit report carries no
    // 'not logged in' / 'bad credentials' token, so it stays authenticated.
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr: "API rate limit exceeded. try again later",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(true);
  });

  it("unrecognised non-zero with no auth context → conservative unauthenticated", async () => {
    const out: ExecOutput = { code: 1, stdout: "", stderr: "some unexpected gh failure" };
    expect(await ghAuthenticated(ctxWith(out))).toBe(false);
  });

  it("transient error carrying an auth hint → transient wins (still authenticated)", async () => {
    // A rate-limit / 5xx blip whose retry advice mentions `gh auth login` would
    // ALSO match the unauthenticated pattern. The transient classifier must be
    // tested FIRST so the still-configured token is not misread as missing.
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr:
        "github.com\n  X error validating token: API rate limit exceeded for user ID 42.\n" +
        "  try again later; run `gh auth login` if this persists.",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(true);
  });

  it("5xx blip whose body also names bad credentials → transient still wins", async () => {
    const out: ExecOutput = {
      code: 1,
      stdout: "",
      stderr: "503 Service Unavailable while checking token — would otherwise read: Bad credentials",
    };
    expect(await ghAuthenticated(ctxWith(out))).toBe(true);
  });
});
