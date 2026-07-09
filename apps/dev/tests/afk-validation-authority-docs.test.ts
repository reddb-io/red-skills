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
