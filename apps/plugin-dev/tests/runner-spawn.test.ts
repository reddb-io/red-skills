import { describe, expect, it } from "vitest";
import {
  claudeSpawnArgs,
  codexSpawnArgs,
  isRunnerExhausted,
  specialUserRequestBlock,
} from "../src/core/runner-spawn.js";
import { isExhaustionError } from "../src/core/execution/runtime.js";
import { recoveryReasonFor } from "../src/core/worker-outcome.js";

describe("specialUserRequestBlock (special_user_request_block parity)", () => {
  it("returns null when no request is set, and the block otherwise", () => {
    expect(specialUserRequestBlock(undefined)).toBeNull();
    expect(specialUserRequestBlock("")).toBeNull();
    expect(specialUserRequestBlock("do X")).toBe("---- SPECIAL USER REQUEST ------\ndo X\n-------------------------------");
  });
});

describe("claudeSpawnArgs / codexSpawnArgs (runner-*.md argv parity)", () => {
  it("builds the claude stream-json argv with the prompt last", () => {
    const inv = claudeSpawnArgs({ prompt: "PROMPT", worktree: "/wt" });
    expect(inv.command).toBe("claude");
    expect(inv.args).toEqual([
      "--model",
      "opus",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      "PROMPT",
    ]);
  });

  it("builds the codex exec --json argv with model, reasoning effort, worktree, and last-message sink", () => {
    const inv = codexSpawnArgs({
      prompt: "PROMPT",
      worktree: "/wt",
      lastMessagePath: "/tmp/last",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(inv.command).toBe("codex");
    expect(inv.args).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "-c",
      "model_reasoning_effort=high",
      "--json",
      "-C",
      "/wt",
      "--sandbox",
      "danger-full-access",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message",
      "/tmp/last",
      "PROMPT",
    ]);
  });
});

describe("isRunnerExhausted (run_inner exhaustion grep)", () => {
  it("matches the documented usage-limit strings, case-insensitively", () => {
    expect(isRunnerExhausted("you hit your usage limit")).toBe(true);
    expect(isRunnerExhausted("Weekly cap reached")).toBe(true);
    expect(isRunnerExhausted("session exhausted")).toBe(true);
    expect(isRunnerExhausted("rate_limit_error")).toBe(true);
    expect(isRunnerExhausted("please try again later")).toBe(true);
    expect(isRunnerExhausted("normal work output")).toBe(false);
  });

  it("recognises a GitHub primary rate limit, which is a 403 and matches no AI-runner signal (#2830)", () => {
    expect(isRunnerExhausted("HTTP 403: API rate limit exceeded for user ID 12345.")).toBe(true);
    expect(isRunnerExhausted("HTTP 403: You have exceeded a secondary rate limit.")).toBe(true);
    expect(isRunnerExhausted('{"errors":[{"type":"RATE_LIMITED"}]}')).toBe(true);
  });

  it("maps a GitHub quota failure to the same bounded quota recovery reason as the AI-runner signals", () => {
    for (const text of ["HTTP 403: API rate limit exceeded for user ID 12345.", "you hit your usage limit"]) {
      expect(isRunnerExhausted(text)).toBe(true);
    }
    // `exhausted` is the outcome a matched exhaustion text produces; its
    // recovery reason is the bounded `quota` path.
    expect(recoveryReasonFor("exhausted")).toBe("quota");
  });

  it("keeps permanent GitHub failures out of the quota bucket", () => {
    expect(isRunnerExhausted("HTTP 401: Bad credentials")).toBe(false);
    expect(isRunnerExhausted("HTTP 404: Not Found")).toBe(false);
  });
});

describe("isExhaustionError (thrown-error seam)", () => {
  it("reclassifies a thrown GitHub rate-limit error as exhaustion", () => {
    expect(isExhaustionError(new Error("HTTP 403: API rate limit exceeded for user ID 12345."))).toBe(true);
  });

  it("leaves a thrown authentication error alone", () => {
    expect(isExhaustionError(new Error("HTTP 401: Bad credentials"))).toBe(false);
  });
});
