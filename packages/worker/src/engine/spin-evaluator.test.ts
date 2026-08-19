import { describe, expect, it } from "vitest";
import { evaluateSpin } from "./index.js";

describe("evaluateSpin", () => {
  it("names a repeated action-observation Spin", () => {
    expect(
      evaluateSpin([
        { kind: "action", content: "run pnpm test" },
        { kind: "observation", content: "1 test failed" },
        { kind: "action", content: "run pnpm test" },
        { kind: "observation", content: "1 test failed" },
        { kind: "action", content: "run pnpm test" },
        { kind: "observation", content: "1 test failed" },
      ]),
    ).toEqual({ pattern: "repeated-action-observation" });
  });

  it("names an error streak for the same action", () => {
    expect(
      evaluateSpin([
        { kind: "action", content: "compile src/index.ts" },
        { kind: "error", content: "type mismatch" },
        { kind: "action", content: "compile src/index.ts" },
        { kind: "error", content: "still does not compile" },
        { kind: "action", content: "compile src/index.ts" },
        { kind: "error", content: "type mismatch at line 42" },
      ]),
    ).toEqual({ pattern: "error-streak" });
  });

  it("names a monologue with no intervening tool activity", () => {
    expect(
      evaluateSpin([
        { kind: "message", content: "I should inspect the failure." },
        { kind: "message", content: "Perhaps the parser is responsible." },
        { kind: "message", content: "I could inspect the parser." },
        { kind: "message", content: "The types may also be relevant." },
        { kind: "message", content: "I should compare the inputs." },
        { kind: "message", content: "Let me think about that." },
      ]),
    ).toEqual({ pattern: "monologue" });
  });

  it("names two action-observation pairs cycling in ping-pong", () => {
    expect(
      evaluateSpin([
        { kind: "action", content: "enable strict mode" },
        { kind: "observation", content: "parser test fails" },
        { kind: "action", content: "disable strict mode" },
        { kind: "observation", content: "typecheck fails" },
        { kind: "action", content: "enable strict mode" },
        { kind: "observation", content: "parser test fails" },
        { kind: "action", content: "disable strict mode" },
        { kind: "observation", content: "typecheck fails" },
        { kind: "action", content: "enable strict mode" },
        { kind: "observation", content: "parser test fails" },
        { kind: "action", content: "disable strict mode" },
        { kind: "observation", content: "typecheck fails" },
      ]),
    ).toEqual({ pattern: "alternating-ping-pong" });
  });

  it("compares actions and observations semantically across volatile tokens", () => {
    expect(
      evaluateSpin([
        { kind: "action", content: "inspect pid=4101 at 0xaaa111" },
        {
          kind: "observation",
          content:
            "failed at 2026-08-13T18:01:02.003Z from 0xbbb111 on 10.0.0.1:4101",
        },
        { kind: "action", content: "inspect pid=5277 at 0xaaa222" },
        {
          kind: "observation",
          content:
            "failed at 2026-08-13T18:02:03.004Z from 0xbbb222 on 10.0.0.2:5277",
        },
        { kind: "action", content: "inspect pid=6388 at 0xaaa333" },
        {
          kind: "observation",
          content:
            "failed at 2026-08-13T18:03:04.005Z from 0xbbb333 on 10.0.0.3:6388",
        },
      ]),
    ).toEqual({ pattern: "repeated-action-observation" });
  });

  it("returns null for near misses that are genuinely advancing", () => {
    expect(
      evaluateSpin([
        { kind: "action", content: "test shard 1" },
        { kind: "observation", content: "1 test failed" },
        { kind: "action", content: "test shard 2" },
        { kind: "observation", content: "1 test failed" },
        { kind: "action", content: "test shard 3" },
        { kind: "observation", content: "1 test failed" },
      ]),
    ).toBeNull();

    expect(
      evaluateSpin([
        { kind: "action", content: "compile package alpha" },
        { kind: "error", content: "type mismatch" },
        { kind: "action", content: "compile package beta" },
        { kind: "error", content: "type mismatch" },
        { kind: "action", content: "compile package gamma" },
        { kind: "error", content: "type mismatch" },
      ]),
    ).toBeNull();

    expect(
      evaluateSpin([
        { kind: "message", content: "First thought" },
        { kind: "message", content: "Second thought" },
        { kind: "action", content: "inspect the source" },
        { kind: "message", content: "Third thought" },
        { kind: "message", content: "Fourth thought" },
        { kind: "message", content: "Fifth thought" },
      ]),
    ).toBeNull();

    expect(
      evaluateSpin([
        { kind: "action", content: "set mode A" },
        { kind: "observation", content: "failure A" },
        { kind: "action", content: "set mode B" },
        { kind: "observation", content: "failure B" },
        { kind: "action", content: "set mode A" },
        { kind: "observation", content: "failure A" },
        { kind: "action", content: "set mode B" },
        { kind: "observation", content: "failure B" },
        { kind: "action", content: "set mode A" },
        { kind: "observation", content: "failure A" },
        { kind: "action", content: "set mode C" },
        { kind: "observation", content: "failure C" },
      ]),
    ).toBeNull();
  });
});
