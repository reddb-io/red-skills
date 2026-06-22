import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  parseMakeTargets,
  suggestHooksFromRepo,
  type HookSuggestion,
  type SignalFs,
} from "../src/core/suggest-hooks.js";

/**
 * Fixture filesystem builder. Pass file paths → contents for text files;
 * non-string truthy values mark directory/presence-only entries (exists but
 * not readable as text). Missing keys → not present.
 */
function fakeFs(files: Record<string, string | true>): SignalFs {
  return {
    readText: (path) => {
      const v = files[path];
      return typeof v === "string" ? v : null;
    },
    exists: (path) => path in files,
  };
}

/** Assert a suggestion with the given point + name is present. */
function hasSuggestion(suggestions: HookSuggestion[], point: string, name: string): boolean {
  return suggestions.some((s) => s.point === point && s.name === name);
}

describe("detectPackageManager", () => {
  it("returns pnpm when pnpm-lock.yaml is present", () => {
    const fs = fakeFs({ "/r/pnpm-lock.yaml": true });
    expect(detectPackageManager("/r", fs)).toBe("pnpm");
  });

  it("returns yarn when yarn.lock is present and no pnpm lockfile", () => {
    const fs = fakeFs({ "/r/yarn.lock": true });
    expect(detectPackageManager("/r", fs)).toBe("yarn");
  });

  it("prefers pnpm over yarn when both lockfiles are present", () => {
    const fs = fakeFs({ "/r/pnpm-lock.yaml": true, "/r/yarn.lock": true });
    expect(detectPackageManager("/r", fs)).toBe("pnpm");
  });

  it("falls back to npm when no lockfile is present", () => {
    expect(detectPackageManager("/r", fakeFs({}))).toBe("npm");
  });
});

describe("parseMakeTargets", () => {
  it("returns an empty list for an empty Makefile", () => {
    expect(parseMakeTargets("")).toEqual([]);
  });

  it("parses targets with no dependencies", () => {
    const makefile = "test:\n\tnpm test\n\nbuild:\n\tnpm run build\n";
    expect(parseMakeTargets(makefile)).toContain("test");
    expect(parseMakeTargets(makefile)).toContain("build");
  });

  it("parses targets with dependency lists", () => {
    const makefile = "test: build lint\n\techo ok\n";
    expect(parseMakeTargets(makefile)).toContain("test");
  });

  it("excludes := variable assignment lines", () => {
    const makefile = "CFLAGS:=-O2 -Wall\ntest:\n\techo ok\n";
    const targets = parseMakeTargets(makefile);
    expect(targets).not.toContain("CFLAGS");
    expect(targets).toContain("test");
  });

  it("excludes recipe lines that start with a tab", () => {
    const makefile = "test:\n\ttest -f foo\n";
    const targets = parseMakeTargets(makefile);
    expect(targets).toEqual(["test"]);
  });

  it("deduplicates targets that appear more than once", () => {
    const makefile = "test: build\ntest: lint\n";
    expect(parseMakeTargets(makefile).filter((t) => t === "test")).toHaveLength(1);
  });
});

describe("suggestHooksFromRepo", () => {
  it("returns no suggestions when the repo has no signals", () => {
    expect(suggestHooksFromRepo("/r", fakeFs({}))).toEqual([]);
  });

  // package.json signals

  it("suggests pre_merge red-run-tests.sh when package.json has test script", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"test":"vitest"}}' });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-run-tests.sh")).toBe(true);
  });

  it("suggests pre_merge red-typecheck.sh for scripts.typecheck", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"typecheck":"tsc --noEmit"}}' });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-typecheck.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-typecheck.sh")?.content).toContain("typecheck");
  });

  it("suggests pre_merge red-typecheck.sh for scripts.type-check", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"type-check":"tsc --noEmit"}}' });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-typecheck.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-typecheck.sh")?.content).toContain("type-check");
  });

  it("prefers scripts.typecheck over scripts.type-check when both present", () => {
    const fs = fakeFs({
      "/r/package.json": '{"scripts":{"typecheck":"tsc","type-check":"tsc2"}}',
    });
    const s = suggestHooksFromRepo("/r", fs);
    const suggestion = s.find((x) => x.name === "red-typecheck.sh");
    expect(suggestion?.content).toContain("typecheck");
    expect(suggestion?.content).not.toContain("type-check");
    // Only one typecheck suggestion even with both keys
    expect(s.filter((x) => x.name === "red-typecheck.sh")).toHaveLength(1);
  });

  it("suggests pre_merge red-lint.sh when package.json has lint script", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"lint":"eslint ."}}' });
    expect(hasSuggestion(suggestHooksFromRepo("/r", fs), "pre_merge", "red-lint.sh")).toBe(true);
  });

  it("suggests pre_merge red-build.sh when package.json has build script", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"build":"tsc"}}' });
    expect(hasSuggestion(suggestHooksFromRepo("/r", fs), "pre_merge", "red-build.sh")).toBe(true);
  });

  it("suggests post_merge (not pre_merge) red-e2e.sh for scripts.e2e", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"e2e":"playwright test"}}' });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "post_merge", "red-e2e.sh")).toBe(true);
    expect(hasSuggestion(s, "pre_merge", "red-e2e.sh")).toBe(false);
  });

  it("suggests post_merge red-e2e.sh for scripts.test:e2e", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"test:e2e":"playwright test"}}' });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "post_merge", "red-e2e.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-e2e.sh")?.content).toContain("test:e2e");
  });

  it("produces no suggestions for a package.json with no matching scripts", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"start":"node server.js"}}' });
    expect(suggestHooksFromRepo("/r", fs)).toEqual([]);
  });

  it("skips malformed package.json without throwing", () => {
    const fs = fakeFs({ "/r/package.json": "not json" });
    expect(() => suggestHooksFromRepo("/r", fs)).not.toThrow();
    expect(suggestHooksFromRepo("/r", fs)).toEqual([]);
  });

  // Package manager selection in script content

  it("uses pnpm run when pnpm-lock.yaml is present", () => {
    const fs = fakeFs({
      "/r/package.json": '{"scripts":{"test":"vitest"}}',
      "/r/pnpm-lock.yaml": true,
    });
    const s = suggestHooksFromRepo("/r", fs);
    expect(s.find((x) => x.name === "red-run-tests.sh")?.content).toContain("pnpm run test");
  });

  it("uses yarn run when yarn.lock is present", () => {
    const fs = fakeFs({
      "/r/package.json": '{"scripts":{"test":"jest"}}',
      "/r/yarn.lock": true,
    });
    const s = suggestHooksFromRepo("/r", fs);
    expect(s.find((x) => x.name === "red-run-tests.sh")?.content).toContain("yarn run test");
  });

  it("uses npm run when no lockfile is detected", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"test":"jest"}}' });
    expect(suggestHooksFromRepo("/r", fs).find((x) => x.name === "red-run-tests.sh")?.content).toContain(
      "npm run test",
    );
  });

  // Makefile signals

  it("suggests pre_merge red-make-test.sh for a Makefile with a test target", () => {
    const fs = fakeFs({ "/r/Makefile": "test:\n\tgo test ./...\n" });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-make-test.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-make-test.sh")?.content).toContain("make test");
  });

  it("suggests hooks for each matching CI target found in Makefile", () => {
    const fs = fakeFs({ "/r/Makefile": "test:\n\t:\nlint:\n\t:\nverify:\n\t:\n" });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-make-test.sh")).toBe(true);
    expect(hasSuggestion(s, "pre_merge", "red-make-lint.sh")).toBe(true);
    expect(hasSuggestion(s, "pre_merge", "red-make-verify.sh")).toBe(true);
  });

  it("ignores Makefile targets that are not CI conventions", () => {
    const fs = fakeFs({ "/r/Makefile": "deploy:\n\t:\nclean:\n\t:\n" });
    expect(suggestHooksFromRepo("/r", fs)).toEqual([]);
  });

  it("produces no Makefile suggestions when Makefile is absent", () => {
    expect(suggestHooksFromRepo("/r", fakeFs({}))).toEqual([]);
  });

  // Cargo / Gradle signals

  it("suggests pre_merge red-cargo-test.sh when Cargo.toml is present", () => {
    const fs = fakeFs({ "/r/Cargo.toml": true });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-cargo-test.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-cargo-test.sh")?.content).toContain("cargo test");
  });

  it("suggests pre_merge red-gradle-check.sh when build.gradle is present", () => {
    const fs = fakeFs({ "/r/build.gradle": true });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-gradle-check.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-gradle-check.sh")?.content).toContain("./gradlew check");
  });

  it("suggests pre_merge red-gradle-check.sh when build.gradle.kts is present", () => {
    const fs = fakeFs({ "/r/build.gradle.kts": true });
    expect(hasSuggestion(suggestHooksFromRepo("/r", fs), "pre_merge", "red-gradle-check.sh")).toBe(true);
  });

  // husky / pre-commit signals

  it("suggests pre_merge red-lint-staged.sh when .husky/ directory is present", () => {
    const fs = fakeFs({ "/r/.husky": true });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-lint-staged.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-lint-staged.sh")?.content).toContain("npx lint-staged");
  });

  it("suggests pre_merge red-pre-commit.sh when .pre-commit-config.yaml is present", () => {
    const fs = fakeFs({ "/r/.pre-commit-config.yaml": "repos: []" });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "pre_merge", "red-pre-commit.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-pre-commit.sh")?.content).toContain("pre-commit run --all-files");
  });

  // Slack webhook signal

  it("suggests post_merge red-slack-notify.sh when .env.example has SLACK_WEBHOOK_URL", () => {
    const fs = fakeFs({ "/r/.env.example": "SLACK_WEBHOOK_URL=https://hooks.slack.com/...\n" });
    const s = suggestHooksFromRepo("/r", fs);
    expect(hasSuggestion(s, "post_merge", "red-slack-notify.sh")).toBe(true);
    expect(s.find((x) => x.name === "red-slack-notify.sh")?.content).toContain("SLACK_WEBHOOK_URL");
  });

  it("suggests post_merge red-slack-notify.sh when .env.example has SLACK_INCOMING_WEBHOOK", () => {
    const fs = fakeFs({ "/r/.env.example": "SLACK_INCOMING_WEBHOOK=https://...\n" });
    expect(hasSuggestion(suggestHooksFromRepo("/r", fs), "post_merge", "red-slack-notify.sh")).toBe(true);
  });

  it("does not suggest Slack hook when .env.example has no Slack vars", () => {
    const fs = fakeFs({ "/r/.env.example": "DATABASE_URL=postgres://localhost/mydb\n" });
    expect(hasSuggestion(suggestHooksFromRepo("/r", fs), "post_merge", "red-slack-notify.sh")).toBe(false);
  });

  it("does not suggest Slack hook when .env.example is absent", () => {
    expect(hasSuggestion(suggestHooksFromRepo("/r", fakeFs({})), "post_merge", "red-slack-notify.sh")).toBe(
      false,
    );
  });

  // Signal and content invariants

  it("includes a non-empty signal description for every suggestion", () => {
    const fs = fakeFs({
      "/r/package.json": '{"scripts":{"test":"vitest","lint":"eslint ."}}',
      "/r/pnpm-lock.yaml": true,
      "/r/Cargo.toml": true,
      "/r/.env.example": "SLACK_WEBHOOK_URL=x",
    });
    const s = suggestHooksFromRepo("/r", fs);
    for (const suggestion of s) {
      expect(suggestion.signal.length).toBeGreaterThan(0);
    }
  });

  it("every suggested script name starts with red- and ends with .sh", () => {
    const fs = fakeFs({
      "/r/package.json": '{"scripts":{"test":"v","lint":"e","build":"t","typecheck":"tsc","e2e":"pw"}}',
      "/r/Makefile": "test:\n\t:\n",
      "/r/Cargo.toml": true,
      "/r/build.gradle": true,
      "/r/.husky": true,
      "/r/.pre-commit-config.yaml": "repos: []",
      "/r/.env.example": "SLACK_WEBHOOK_URL=x",
    });
    for (const s of suggestHooksFromRepo("/r", fs)) {
      expect(s.name).toMatch(/^red-.+\.sh$/);
    }
  });

  it("every suggested script starts with a bash shebang and set -euo pipefail", () => {
    const fs = fakeFs({ "/r/package.json": '{"scripts":{"test":"vitest"}}' });
    for (const s of suggestHooksFromRepo("/r", fs)) {
      expect(s.content).toContain("#!/usr/bin/env bash");
      expect(s.content).toContain("set -euo pipefail");
    }
  });

  // Offer-only invariant

  it("never writes to the filesystem — suggestions are returned, not applied", () => {
    // SignalFs has no write method; this test documents the contract.
    const written: string[] = [];
    const fs: SignalFs = {
      readText: (p) => (p === "/r/package.json" ? '{"scripts":{"test":"vitest"}}' : null),
      exists: (p) => p === "/r/pnpm-lock.yaml",
    };
    const suggestions = suggestHooksFromRepo("/r", fs);
    expect(written).toHaveLength(0); // no writes ever happen
    expect(suggestions.length).toBeGreaterThan(0); // suggestions are produced
  });
});
