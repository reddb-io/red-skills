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

  it("documents the loop, primary-branch rule, and kill-switch flag", () => {
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("worktree");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("push the branch early");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("`/ship`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("merge the PR or park the issue/PR for `/hitl`");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("The agent never switches the primary checkout's branch; only the user does.");
    expect(DEVELOPMENT_WORKFLOW_BLOCK).toContain("`dev.lock.primary-branch`");
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
    expect(config).toBe("dev:\n  lock:\n    primary-branch: true\n");

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
    expect(plan.configYaml).toBe("afk:\n  default_runner: codex\n\ndev:\n  lock:\n    primary-branch: true\n");
  });

  it("activates dev.lock.primary-branch in existing config without duplicating it", () => {
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
    expect(once).toContain("dev:\n  lock:\n    primary-branch: true\n");
    expect((once.match(/^    primary-branch:/gm) ?? [])).toHaveLength(1);
  });

  it("adds the primary-branch lock setting to an existing dev config block", () => {
    expect(activatePrimaryBranchLockConfig("dev:\n  other: yes\nafk:\n  default_runner: codex\n")).toBe(
      "dev:\n  lock:\n    primary-branch: true\n  other: yes\nafk:\n  default_runner: codex\n",
    );
  });
});
