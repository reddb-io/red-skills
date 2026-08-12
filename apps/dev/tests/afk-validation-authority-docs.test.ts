import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const AFK = "plugins/dev/skills/engineering/afk";

async function readAgentPrompt(): Promise<string> {
  return readFile(join(ROOT, AFK, "AGENT-PROMPT.md"), "utf8");
}

async function readAfkSkill(): Promise<string> {
  return readFile(join(ROOT, AFK, "SKILL.md"), "utf8");
}

async function readAfkOperations(): Promise<string> {
  return readFile(join(ROOT, AFK, "docs", "OPERATIONS.md"), "utf8");
}

async function readAfkSafety(): Promise<string> {
  return readFile(join(ROOT, AFK, "SAFETY.md"), "utf8");
}

describe("afk validation-authority docs contract (#1334)", () => {
  it("AGENT-PROMPT carries a binding Validation Authority section", async () => {
    const prompt = await readAgentPrompt();

    expect(prompt).toContain("## Validation Authority (binding)");
    expect(prompt).toContain("The gate command is canonical");
  });

  it("AGENT-PROMPT forbids self-imposed stricter flags and extra lints", async () => {
    const prompt = await readAgentPrompt();

    expect(prompt).toContain("Never add stricter flags");
    expect(prompt).toContain("--all-targets");
    expect(prompt).toContain("extra lint restrictions");
  });

  it("AGENT-PROMPT states the mirage-reconciliation rule", async () => {
    const prompt = await readAgentPrompt();

    expect(prompt).toContain("is a mirage");
    // reconcile against the gate's real command before believing the error class
    expect(prompt).toContain("Re-run that exact command, unmodified");
    expect(prompt).toContain("clippy.toml");
  });

  it("AGENT-PROMPT forbids condemning main on a check the gate does not run", async () => {
    const prompt = await readAgentPrompt();

    expect(prompt).toContain("Never report `main` as red");
  });

  it("AFK SKILL.md feedback-loops step names the gate as the sole validation authority", async () => {
    const skill = await readAfkSkill();

    expect(skill).toContain("The gate command is canonical");
    expect(skill).toContain("never self-impose stricter flags");
  });

  it("AFK operations reference carries migrated lifecycle and flow-bug guardrails", async () => {
    const operations = await readAfkOperations();

    expect(operations).toContain("## Issue Lifecycle (the `/afk` slice)");
    expect(operations).toContain("Empty queue + non-empty backlog = flow bug");
    expect(operations).toContain("gate census");
  });
});

describe("afk inner-agent GitHub read rail (#3724)", () => {
  it("requires explicit REST forms instead of GraphQL-backed gh convenience reads", async () => {
    const prompt = await readAgentPrompt();

    expect(prompt).toContain("GitHub reads use `gh api` REST forms");
    expect(prompt).toContain("| Issue by number | `gh api repos/{owner}/{repo}/issues/{number}` |");
    expect(prompt).toContain("| Pull request by number | `gh api repos/{owner}/{repo}/pulls/{number}` |");
    expect(prompt).toContain("| Check runs for a commit | `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` |");
    expect(prompt).toContain("Never use `gh issue view`, `gh pr view`, or `gh pr checks`");
  });
});

describe("afk primary-checkout safety contract (#2479)", () => {
  it("never snapshots a dirty primary before a worker reaches Landing", async () => {
    const [safety, operations] = await Promise.all([readAfkSafety(), readAfkOperations()]);

    expect(safety).toContain("AFK never stages or commits the primary checkout");
    expect(operations).toContain(
      "A crash or gate failure before Landing leaves a dirty primary checkout byte-for-byte untouched.",
    );
  });

  it("protects the direct Landing merge inside its isolated worktree", async () => {
    const [safety, operations] = await Promise.all([readAfkSafety(), readAfkOperations()]);

    expect(safety).toContain("isolated landing worktree");
    expect(operations).toContain(
      "`pre_merge_sha` is captured inside that isolated worktree immediately before `merge --no-ff`",
    );
  });
});
