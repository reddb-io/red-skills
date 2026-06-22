import { describe, expect, it, vi } from "vitest";
import {
  classifyCommand,
  unknownHookNames,
  validateHookConfig,
  type ClassifyContext,
} from "../src/core/hook-doctor.js";

/**
 * Fixture context: a repo with a `test` + `lint` script, a `.red/hooks/...`
 * file on disk, and one resolvable `red-validation` library hook. Prior art:
 * doctor-docs.test.ts. The key invariant of this whole module is that NOTHING
 * is ever executed — every test runs against injected facts.
 */
function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    packageScripts: new Set(["test", "lint", "build"]),
    fileExists: (p) => p === ".red/hooks/post_merge/notify.sh",
    libraryScripts: new Set(["red-validation", "red-heartbeat"]),
    ...overrides,
  };
}

describe("classifyCommand — static, never executes", () => {
  it("✅ a package.json script that exists", () => {
    expect(classifyCommand("pnpm run test", ctx()).verdict).toBe("ok");
    expect(classifyCommand("npm run lint", ctx()).verdict).toBe("ok");
    expect(classifyCommand("pnpm test", ctx()).verdict).toBe("ok");
  });

  it("❌ a renamed/missing package.json script referenced via run", () => {
    const f = classifyCommand("pnpm run typcheck", ctx()); // typo
    expect(f.verdict).toBe("error");
    expect(f.reason).toContain("typcheck");
  });

  it("❌ a hook/backpressure command referencing a non-existent file", () => {
    const f = classifyCommand("bash .red/hooks/post_merge/missing.sh", ctx());
    expect(f.verdict).toBe("error");
    expect(f.reason).toContain("does not exist");
  });

  it("✅ a file path that exists", () => {
    expect(classifyCommand(".red/hooks/post_merge/notify.sh", ctx()).verdict).toBe("ok");
  });

  it("✅ a red-* library/shadow target that resolves; ❌ one that does not", () => {
    expect(classifyCommand("red-validation --strict", ctx()).verdict).toBe("ok");
    const f = classifyCommand("red-nope", ctx());
    expect(f.verdict).toBe("error");
    expect(f.reason).toContain("red-nope");
  });

  it("⚠️ an unresolvable bare PATH binary is conservative, not a hard fail", () => {
    expect(classifyCommand("curl -s https://example.com", ctx()).verdict).toBe("warn");
    expect(classifyCommand("make ci", ctx()).verdict).toBe("warn");
  });

  it("strips a leading env-var prefix before classifying", () => {
    expect(classifyCommand("FOO=bar pnpm run test", ctx()).verdict).toBe("ok");
  });

  it("never invokes any execution callback", () => {
    // There is no exec seam to spy on — the function takes only data + pure
    // predicates. Prove it by asserting fileExists is consulted, not a runner:
    const fileExists = vi.fn((p: string) => p === ".red/hooks/post_merge/notify.sh");
    classifyCommand("bash .red/hooks/post_merge/notify.sh", ctx({ fileExists }));
    expect(fileExists).toHaveBeenCalled();
  });
});

describe("unknownHookNames — pre-catch read-only", () => {
  it("flags an unknown hook name and passes canonical ones", () => {
    expect(unknownHookNames(["pre_merge", "post_attempt"])).toEqual([]);
    expect(unknownHookNames(["pre_merge", "on_bogus"])).toEqual(["on_bogus"]);
  });
});

describe("validateHookConfig — aggregate report", () => {
  it("classifies backpressure + hook commands and collects unknown names", () => {
    const report = validateHookConfig(
      {
        backpressure: ["pnpm run test", "pnpm run nope"],
        hookCommands: [{ hook: "post_merge", command: ".red/hooks/post_merge/notify.sh" }],
        declaredHookNames: ["post_merge", "on_bogus"],
      },
      ctx(),
    );
    expect(report.backpressure.map((f) => f.verdict)).toEqual(["ok", "error"]);
    expect(report.hooks[0].finding.verdict).toBe("ok");
    expect(report.unknownHooks).toEqual(["on_bogus"]);
  });
});
