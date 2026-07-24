/**
 * Command-classifier suite (#2659).
 *
 * Every rsp surface — the pre-exec hook, the universal proxy, and telemetry
 * reporting — classifies raw shell commands through `src/command-classifier.ts`.
 * The classification cases live here once; each surface keeps a wired smoke
 * proving it reads the shared module rather than its own copy.
 *
 * `TELEMETRY_KEY_CORPUS` is a byte-for-byte pin of the `command_family`
 * telemetry keys. `family` holds the value captured from the pre-refactor
 * hook/proxy copy; `legacyReportsFamily` is present only on the rows where the
 * `telemetry/reports.ts` copy had drifted behind (it predated gh json/jq
 * awareness) and is recorded here so the deliberate reconciliation stays
 * auditable.
 */

import { describe, expect, it } from "vitest";
import {
  commandFamily,
  commandSegments,
  commandWords,
  isEnvAssignment,
  isGhJsonJqSelection,
  isJsonJqSelectionFlag,
  shellishWords,
} from "../src/command-classifier.js";
import { rewriteCommand } from "../src/intercept.js";
import { rewriteProxyCommandLine } from "../src/proxy.js";

interface TelemetryKeyRow {
  command: string;
  family: string;
  legacyReportsFamily?: string;
}

const TELEMETRY_KEY_CORPUS: readonly TelemetryKeyRow[] = [
  { command: "", family: "unknown" },
  { command: "   ", family: "unknown" },
  { command: "git status", family: "git status" },
  { command: "git status --short", family: "git status" },
  { command: "git log --oneline --decorate=short", family: "git log" },
  { command: "git diff --stat origin/main..HEAD", family: "git diff" },
  { command: "git show HEAD", family: "git show" },
  { command: "git blame src/a.ts", family: "git blame" },
  { command: "git branch -av", family: "git branch" },
  { command: "git commit -m 'x'", family: "git commit" },
  { command: "git push origin HEAD", family: "git push" },
  { command: "git", family: "git" },
  { command: "gh pr list --limit 5", family: "gh pr list" },
  { command: "gh pr view 1747", family: "gh pr view" },
  { command: "gh issue list", family: "gh issue list" },
  { command: "gh issue view 2659", family: "gh issue view" },
  { command: "gh run list", family: "gh run list" },
  { command: "gh run view 9001", family: "gh run view" },
  { command: "gh api repos/o/r", family: "gh api repos/o/r" },
  { command: "gh pr", family: "gh pr" },
  { command: "gh", family: "gh" },
  { command: "cargo test", family: "cargo test" },
  { command: "cargo build", family: "cargo build" },
  { command: "cargo", family: "cargo" },
  { command: "vitest", family: "vitest" },
  { command: "vitest run", family: "vitest" },
  { command: "cat README.md", family: "cat" },
  { command: "head -n 20 file.txt", family: "head" },
  { command: "tail -n 5 file.txt", family: "tail" },
  { command: "echo ok", family: "echo" },
  { command: "grep -q needle file.txt", family: "grep" },
  { command: "gh pr view 1747 --json number,title", family: "gh pr view json-jq", legacyReportsFamily: "gh pr view" },
  { command: "gh pr list --json number,title --jq '.[0]'", family: "gh pr list json-jq", legacyReportsFamily: "gh pr list" },
  { command: "gh run view 9001 --json databaseId --jq .databaseId", family: "gh run view json-jq", legacyReportsFamily: "gh run view" },
  { command: "gh api repos/o/r --jq .name", family: "gh api repos/o/r json-jq", legacyReportsFamily: "gh api repos/o/r" },
  { command: "gh --json x", family: "gh --json x json-jq", legacyReportsFamily: "gh --json x" },
  { command: "gh pr --jq .", family: "gh pr --jq json-jq", legacyReportsFamily: "gh pr --jq" },
  { command: "gh pr view --json=number", family: "gh pr view json-jq", legacyReportsFamily: "gh pr view" },
  { command: "gh pr view --jq=.number", family: "gh pr view json-jq", legacyReportsFamily: "gh pr view" },
];

describe("command-classifier telemetry key stability (#2659)", () => {
  it.each(TELEMETRY_KEY_CORPUS.map((row) => [row.command || "<blank>", row] as const))(
    "pins the command_family key for %s",
    (_label, row) => {
      expect(commandFamily(row.command)).toBe(row.family);
    },
  );

  it("changes no key outside the deliberate telemetry/reports reconciliation", () => {
    const changed = TELEMETRY_KEY_CORPUS.filter((row) => row.legacyReportsFamily != null).map((row) => row.command);
    expect(changed.every((command) => commandWords(command)[0] === "gh")).toBe(true);
    expect(changed.every((command) => isGhJsonJqSelection(commandWords(command)))).toBe(true);
  });
});

describe("commandFamily", () => {
  it("reports unknown for an empty command", () => {
    expect(commandFamily("")).toBe("unknown");
    expect(commandFamily("  \t ")).toBe("unknown");
  });

  it("keeps the bare executable when no subcommand shape applies", () => {
    expect(commandFamily("echo ok")).toBe("echo");
    expect(commandFamily("vitest run --reporter dot")).toBe("vitest");
  });
});

describe("isGhJsonJqSelection", () => {
  // Moved here from tests/intercept.test.ts — these are classification cases,
  // not rewrite cases; the hook keeps one wired smoke below.
  it.each([
    ["json-fields", "gh pr view 1747 --json number,title"],
    ["jq-expression", "gh run view 9001 --json databaseId --jq '.databaseId'"],
    ["api-jq", "gh api repos/reddb-io/red-skills --jq .name"],
    ["json-equals-form", "gh pr view 1747 --json=number"],
    ["jq-equals-form", "gh pr view 1747 --jq=.number"],
  ])("recognises the lossless gh json/jq selector family %s", (_name, command) => {
    expect(isGhJsonJqSelection(commandWords(command))).toBe(true);
  });

  it.each([
    ["plain-gh", "gh pr list --limit 5"],
    ["non-gh-executable", "git log --json"],
    ["empty", ""],
  ])("does not recognise %s as a json/jq selection", (_name, command) => {
    expect(isGhJsonJqSelection(commandWords(command))).toBe(false);
  });
});

describe("isJsonJqSelectionFlag", () => {
  it.each(["--json", "--jq", "--json=number", "--jq=.number"])("accepts %s", (token) => {
    expect(isJsonJqSelectionFlag(token)).toBe(true);
  });

  it.each(["--jsonl", "--jqx", "-json", "json", ""])("rejects %s", (token) => {
    expect(isJsonJqSelectionFlag(token)).toBe(false);
  });
});

describe("isEnvAssignment", () => {
  it.each(["GIT_DIR=.git", "FOO=", "_x=1", "A1_B=value with spaces"])("accepts %s", (token) => {
    expect(isEnvAssignment(token)).toBe(true);
  });

  it.each(["git", "1FOO=bar", "--flag=value", "=bar", ""])("rejects %s", (token) => {
    expect(isEnvAssignment(token)).toBe(false);
  });
});

describe("shell segment splitting", () => {
  it("splits on the compound operators and trims each segment", () => {
    expect(commandSegments("cd apps && git log | tail -5; echo ok")).toEqual([
      "cd apps",
      "git log",
      "tail -5",
      "echo ok",
    ]);
  });

  it("drops empty segments", () => {
    expect(commandSegments("  ")).toEqual([]);
    expect(commandSegments("git status;;")).toEqual(["git status"]);
  });

  it("splits a segment into shellish words and blanks a leading env keyword", () => {
    expect(shellishWords("git  log\t--oneline")).toEqual(["git", "log", "--oneline"]);
    expect(shellishWords("env git status")).toEqual(["", "git", "status"]);
  });

  it("splits a command into words on any whitespace run", () => {
    expect(commandWords("  git   log\t--oneline ")).toEqual(["git", "log", "--oneline"]);
    expect(commandWords("   ")).toEqual([]);
  });
});

describe("surfaces read the shared classifier", () => {
  it("wires the hook rewrite to isGhJsonJqSelection", () => {
    expect(rewriteCommand("gh pr view 1747 --json number,title", ["rsp"])).toEqual({
      kind: "passthrough",
      reason: "lossless-gh-json-jq",
    });
  });

  it("wires the proxy segment match to commandFamily", () => {
    expect(rewriteProxyCommandLine("gh pr list --json number,title --jq '.[0]'", "brief", ["rsp"]).matches).toEqual([
      expect.objectContaining({ commandFamily: commandFamily("gh pr list --json number,title --jq '.[0]'") }),
    ]);
  });

  // The telemetry/reports wired smoke needs a RedDB store, so it lives with the
  // rest of the store-backed report specs: see "aggregates gh json/jq
  // invocations under the shared command_family key" in
  // tests/telemetry-resident.test.ts.
});
