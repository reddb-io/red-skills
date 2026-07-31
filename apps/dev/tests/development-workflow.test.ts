import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activatePrimaryBranchLockConfig,
  DEVELOPMENT_WORKFLOW_BLOCK,
  DEVELOPMENT_WORKFLOW_HEADING,
  extractMarkdownSection,
  planDevelopmentWorkflowInjection,
  upsertDevelopmentWorkflowBlock,
} from "../src/core/development-workflow.js";
import { injectDevelopmentWorkflowRules } from "../src/commands/inject-development-workflow.js";

describe("development workflow rules block", () => {
  it("appends the canonical block when the section is missing", () => {
    const next = upsertDevelopmentWorkflowBlock("# Rules\n\n## Agent skills\n\nExisting.\n");
    expect(extractMarkdownSection(next, DEVELOPMENT_WORKFLOW_HEADING)).toBe(DEVELOPMENT_WORKFLOW_BLOCK);
    expect(next).toContain("## Agent skills\n\nExisting.");
  });

  it("updates the section in place and stays idempotent", () => {
    const body = [
      "# Rules",
      "",
      "## Development workflow",
      "",
      "Old local wording.",
      "",
      "## Agent skills",
      "",
      "Existing.",
      "",
    ].join("\n");
    const once = upsertDevelopmentWorkflowBlock(body);
    const twice = upsertDevelopmentWorkflowBlock(once);

    expect(once).toBe(twice);
    expect((once.match(/^## Development workflow$/gm) ?? [])).toHaveLength(1);
    expect(extractMarkdownSection(once, DEVELOPMENT_WORKFLOW_HEADING)).toBe(DEVELOPMENT_WORKFLOW_BLOCK);
    expect(once).toContain("## Agent skills\n\nExisting.");
  });

  it("documents the loop and enforced .red/tmp worktree boundary", () => {
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("worktree");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("`.red/tmp/worktrees/manual/<slug>`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("git worktree add .red/tmp/worktrees/manual/<slug>");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("not with `git checkout -b` or `git switch -c`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("push the branch early");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("merge it or park the issue/PR for `/hitl`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("The agent never switches the primary checkout's branch; only the user does.");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("the dev command proxy blocks agent-created worktrees outside registered `.red/tmp/` lanes");
  });

  // #2936: teaching only the NEW-branch form sent people to the bare
  // `git worktree add <dir> <branch>`, which resolves the LOCAL ref — work built
  // on a trailing tip came back from the push as `non-fast-forward` (PRs #2933,
  // #2934). The existing-branch form and the REASON must both be in the block.
  it("documents the existing-branch checkout against the remote ref, with the reason", () => {
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("Check out an EXISTING branch against the REMOTE ref");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("git fetch origin <branch>");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain(
      "git worktree add .red/tmp/worktrees/manual/<slug> -B <branch> origin/<branch>",
    );
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("Never the bare `git worktree add <dir> <branch>`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("resolves the LOCAL ref");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("can trail `origin/<branch>`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("`non-fast-forward`");
  });

  it("routes one-off work through /go and never suggests the retired /ship (ADR 0081)", () => {
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain('One-off concrete work goes through `/go "<demand>"`');
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("shared `.red/tmp/workers/` root");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("`current.kind=go`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).not.toContain("`.red/tmp/go-workers/`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("Route the structured backlog through `/afk`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("`/retake`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).not.toContain("/ship");
  });

  it("writes both AGENTS.md and CLAUDE.md with identical blocks, then reruns unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-workflow-"));
    await writeFile(join(root, "CLAUDE.md"), "# Claude rules\n\n## Agent skills\n\nExisting.\n", "utf8");

    const first = injectDevelopmentWorkflowRules(root);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    const claude = await readFile(join(root, "CLAUDE.md"), "utf8");
    const config = await readFile(join(root, ".red", "config.yaml"), "utf8");

    expect(first.agentsChanged).toBe(true);
    expect(first.claudeChanged).toBe(true);
    expect(first.configChanged).toBe(true);
    expect(extractMarkdownSection(agents, DEVELOPMENT_WORKFLOW_HEADING)).toBe(DEVELOPMENT_WORKFLOW_BLOCK);
    expect(extractMarkdownSection(claude, DEVELOPMENT_WORKFLOW_HEADING)).toBe(DEVELOPMENT_WORKFLOW_BLOCK);
    expect(config).toBe("plugins:\n  dev:\n    lock:\n      primary-branch: true\n");

    const second = injectDevelopmentWorkflowRules(root);
    expect(second.agentsChanged).toBe(false);
    expect(second.claudeChanged).toBe(false);
    expect(second.configChanged).toBe(false);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(await readFile(join(root, ".red", "config.yaml"), "utf8")).toBe(config);
  });

  it("plans parity without filesystem access", () => {
    const plan = planDevelopmentWorkflowInjection({
      agentsMarkdown: "# Agents\n",
      claudeMarkdown: "# Claude\n\n## Development workflow\n\nOld.\n",
      configYaml: "afk:\n  default_runner: codex\n",
    });

    expect(extractMarkdownSection(plan.agentsMarkdown, DEVELOPMENT_WORKFLOW_HEADING)).toBe(DEVELOPMENT_WORKFLOW_BLOCK);
    expect(extractMarkdownSection(plan.claudeMarkdown, DEVELOPMENT_WORKFLOW_HEADING)).toBe(DEVELOPMENT_WORKFLOW_BLOCK);
    expect(plan.configYaml).toBe(
      "afk:\n  default_runner: codex\n\nplugins:\n  dev:\n    lock:\n      primary-branch: true\n",
    );
  });

  it("writes the canonical namespaced plugins.dev.lock.primary-branch and stays idempotent", () => {
    const once = activatePrimaryBranchLockConfig(
      [
        "afk:",
        "  fleet:",
        "    target: 3",
        "",
        "dev:",
        "  lock:",
        "    primary-branch: false",
        "",
      ].join("\n"),
    );
    const twice = activatePrimaryBranchLockConfig(once);

    expect(once).toBe(twice);
    expect(once).toContain("plugins:\n  dev:\n    lock:\n      primary-branch: true\n");
    // The namespaced flag is written exactly once; a legacy top-level
    // `dev.lock.*` is left untouched (the doctor migrates it, not setup).
    expect((once.match(/^ {6}primary-branch:/gm) ?? [])).toHaveLength(1);
    expect(once).toContain("dev:\n  lock:\n    primary-branch: false");
  });

  it("appends a full plugins block when none exists", () => {
    expect(activatePrimaryBranchLockConfig("dev:\n  other: yes\nafk:\n  default_runner: codex\n")).toBe(
      "dev:\n  other: yes\nafk:\n  default_runner: codex\n\nplugins:\n  dev:\n    lock:\n      primary-branch: true\n",
    );
  });

  it("nests the lock under an existing plugins.dev block without disturbing enabled", () => {
    expect(activatePrimaryBranchLockConfig("plugins:\n  dev:\n    enabled: true\n")).toBe(
      "plugins:\n  dev:\n    lock:\n      primary-branch: true\n    enabled: true\n",
    );
  });
});
