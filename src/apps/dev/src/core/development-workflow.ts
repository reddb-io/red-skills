export const DEVELOPMENT_WORKFLOW_HEADING = "Development workflow";

export const DEVELOPMENT_WORKFLOW_BLOCK = `## ${DEVELOPMENT_WORKFLOW_HEADING}

- Work in an isolated worktree; do not change the primary checkout's branch for task work.
- Commit the worktree, push the branch early, then run \`/ship\` to open or reuse a PR.
- Let \`/ship\` monitor checks and reviews, then either merge the PR or park the issue/PR for \`/hitl\`.
- The agent never switches the primary checkout's branch; only the user does. The \`dev.lock-primary-branch\` flag in \`.red/config.yaml\` is the kill-switch for the primary-branch guard.`;

const DEVELOPMENT_WORKFLOW_BODY = DEVELOPMENT_WORKFLOW_BLOCK.replace(/^## [^\n]+\n\n/, "");

function trimBlock(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractMarkdownSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line));
  if (start === -1) return undefined;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trimEnd();
}

export function upsertMarkdownSection(markdown: string, heading: string, body: string): string {
  const lines = markdown.split("\n");
  const headingRe = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "i");
  const start = lines.findIndex((line) => headingRe.test(line));
  const replacement = [`## ${heading}`, "", trimBlock(body)];

  if (start === -1) {
    const prefix = markdown.trimEnd();
    return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${replacement.join("\n")}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const next = [...lines.slice(0, start), ...replacement, ...lines.slice(end)];
  return `${next.join("\n").trimEnd()}\n`;
}

export function upsertDevelopmentWorkflowBlock(markdown: string): string {
  return upsertMarkdownSection(markdown, DEVELOPMENT_WORKFLOW_HEADING, DEVELOPMENT_WORKFLOW_BODY);
}

export interface DevelopmentWorkflowInjectionInput {
  agentsMarkdown?: string;
  claudeMarkdown?: string;
}

export interface DevelopmentWorkflowInjectionPlan {
  agentsMarkdown: string;
  claudeMarkdown: string;
  block: string;
}

export function planDevelopmentWorkflowInjection(
  input: DevelopmentWorkflowInjectionInput,
): DevelopmentWorkflowInjectionPlan {
  return {
    agentsMarkdown: upsertDevelopmentWorkflowBlock(input.agentsMarkdown ?? ""),
    claudeMarkdown: upsertDevelopmentWorkflowBlock(input.claudeMarkdown ?? ""),
    block: DEVELOPMENT_WORKFLOW_BLOCK,
  };
}
