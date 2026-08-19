import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_MAX_LINES_DEFAULT,
  historyTrim,
  parseHistoryLines,
} from "../src/core/history.js";
import { facts, makeDeps, options, precheck, runBoot } from "./boot.helpers.js";

// ---------- precheck ----------

describe("precheck", () => {
  it("passes with no warnings when every precondition holds", () => {
    expect(precheck(facts())).toEqual({ ok: true, warnings: [] });
  });

  it("fails gh-missing first", () => {
    expect(precheck(facts({ ghInstalled: false, ghAuthenticated: false }))).toEqual({
      ok: false,
      failed: "gh-missing",
    });
  });

  it("fails gh-unauthenticated", () => {
    expect(precheck(facts({ ghAuthenticated: false }))).toEqual({
      ok: false,
      failed: "gh-unauthenticated",
    });
  });

  it("fails not-a-git-repo", () => {
    expect(precheck(facts({ isGitRepo: false }))).toEqual({
      ok: false,
      failed: "not-a-git-repo",
    });
  });

  it("leaves https remotes to the operational probe registry", () => {
    expect(
      precheck(facts({ remoteUrls: ["https://github.com/reddb-io/red-skills.git"] })),
    ).toEqual({ ok: true, warnings: [] });
  });

  it("allows an https remote in a CI lane (allowHttpsRemote) — GHA checkout is token-https", () => {
    // The Actions lane checks out an https remote authed by GITHUB_TOKEN; the
    // SSH-only rule must not fire there or every cloud attempt dies at precheck.
    expect(
      precheck(
        facts({
          remoteUrls: ["https://github.com/reddb-io/red-skills.git"],
          allowHttpsRemote: true,
        }),
      ),
    ).toEqual({ ok: true, warnings: [] });
  });

  it("fails no-main-branch", () => {
    expect(precheck(facts({ hasMainBranch: false }))).toEqual({
      ok: false,
      failed: "no-main-branch",
    });
  });

  it("fails not-on-trunk, naming the current branch, expected default branch, and trunk source", () => {
    expect(precheck(facts({ currentBranch: "feature/x" }))).toEqual({
      ok: false,
      failed: "not-on-trunk",
      detail: { current: "feature/x", expected: "main", source: "trunk" },
    });
  });

  it("passes when the current branch matches the configured trunk", () => {
    expect(precheck(facts({ currentBranch: "develop", configuredTrunk: "develop" }))).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("fails not-on-trunk, naming the configured trunk when the checkout is on main", () => {
    expect(precheck(facts({ currentBranch: "main", configuredTrunk: "develop" }))).toEqual({
      ok: false,
      failed: "not-on-trunk",
      detail: { current: "main", expected: "develop", source: "trunk" },
    });
  });

  it("fails not-on-trunk, naming the configured branch pin as the expectation source", () => {
    expect(
      precheck(facts({ currentBranch: "main", configuredTrunk: "release/x", configuredTrunkSource: "pin" })),
    ).toEqual({
      ok: false,
      failed: "not-on-trunk",
      detail: { current: "main", expected: "release/x", source: "pin" },
    });
  });

  it("locked: passes when currentBranch matches the lock value", () => {
    expect(precheck(facts({ currentBranch: "feature-locked", lockedBranch: "feature-locked" }))).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("locked: overrides the configured trunk", () => {
    expect(
      precheck(
        facts({
          currentBranch: "feature-locked",
          lockedBranch: "feature-locked",
          configuredTrunk: "develop",
        }),
      ),
    ).toEqual({
      ok: true,
      warnings: [],
    });
  });

  it("locked: fails not-on-trunk when currentBranch is main instead of the lock value", () => {
    expect(precheck(facts({ currentBranch: "main", lockedBranch: "feature-locked" }))).toEqual({
      ok: false,
      failed: "not-on-trunk",
      detail: { current: "main", expected: "feature-locked", source: "lock" },
    });
  });

  it("locked: fails not-on-trunk when currentBranch is a different branch than the lock value", () => {
    expect(precheck(facts({ currentBranch: "other-branch", lockedBranch: "feature-locked" }))).toEqual({
      ok: false,
      failed: "not-on-trunk",
      detail: { current: "other-branch", expected: "feature-locked", source: "lock" },
    });
  });

  it("treats a missing pnpm as a warning, not a failure", () => {
    const r = precheck(facts({ pnpmInstalled: false }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual(["pnpm not on PATH; feedback loops will be skipped"]);
  });
});

describe("history trim at boot", () => {
  it("runs once and shrinks an oversized castle history fixture to the default", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-boot-history-"));
    const historyPath = join(root, ".red", "state", "castle", "history.toonl");
    await mkdir(join(historyPath, ".."), { recursive: true });
    const fixtureLines = Array.from(
      { length: HISTORY_MAX_LINES_DEFAULT + 1 },
      (_, index) => {
        const issue = index + 1;
        return `  t${issue},${issue},wBOOT,${issue},done,0,codex,null,null`;
      },
    );
    await writeFile(
      historyPath,
      [
        `[${fixtureLines.length}]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:`,
        ...fixtureLines,
        "",
      ].join("\n"),
      "utf8",
    );
    let trimCalls = 0;
    const { deps } = makeDeps({
      trimHistory: async () => {
        trimCalls += 1;
        return historyTrim(historyPath);
      },
    });

    await runBoot(deps, options());

    const history = parseHistoryLines(await readFile(historyPath, "utf8"));
    expect(trimCalls).toBe(1);
    expect(history).toHaveLength(HISTORY_MAX_LINES_DEFAULT);
    expect(history[0]?.issue).toBe(2);
    expect(history.at(-1)?.issue).toBe(HISTORY_MAX_LINES_DEFAULT + 1);
  });
});
