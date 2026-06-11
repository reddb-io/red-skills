export const DEVELOPMENT_WORKFLOW_HEADING = "Development workflow";

export const DEVELOPMENT_WORKFLOW_BLOCK = `## ${DEVELOPMENT_WORKFLOW_HEADING}

- Work in an isolated worktree; do not change the primary checkout's branch for task work.
- Commit the worktree, push the branch early, then run \`/ship\` to open or reuse a PR.
- Let \`/ship\` monitor checks and reviews, then either merge the PR or park the issue/PR for \`/hitl\`.
- The agent never switches the primary checkout's branch; only the user does. The \`dev.lock.primary-branch\` flag in \`.red/config.yaml\` is the kill-switch for the primary-branch guard.`;

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

export function activatePrimaryBranchLockConfig(yaml: string): string {
  const normalised = yaml.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const devStart = lines.findIndex((line) => /^dev:\s*(?:#.*)?$/.test(line));
  const lockBlock = ["  lock:", "    primary-branch: true"];

  // No `dev:` block at all — append the whole nested block.
  if (devStart === -1) {
    const prefix = lines.join("\n").trimEnd();
    return `${prefix}${prefix.length > 0 ? "\n\n" : ""}dev:\n${lockBlock.join("\n")}\n`;
  }

  // Bound the `dev:` block (until the next top-level key).
  let devEnd = lines.length;
  for (let i = devStart + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      devEnd = i;
      break;
    }
  }

  // An existing `  lock:` mapping inside `dev:` — ensure `    primary-branch: true`.
  let lockIdx = -1;
  for (let i = devStart + 1; i < devEnd; i += 1) {
    if (/^  lock:\s*(?:#.*)?$/.test(lines[i]!)) {
      lockIdx = i;
      break;
    }
  }
  if (lockIdx !== -1) {
    // Bound the `lock:` sub-block (until a line indented <= 2 spaces).
    let lockEnd = devEnd;
    for (let i = lockIdx + 1; i < devEnd; i += 1) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      if (/^ {0,2}\S/.test(line)) {
        lockEnd = i;
        break;
      }
    }
    for (let i = lockIdx + 1; i < lockEnd; i += 1) {
      if (/^ {4}primary-branch:\s*/.test(lines[i]!)) {
        lines[i] = "    primary-branch: true";
        return `${lines.join("\n").trimEnd()}\n`;
      }
    }
    lines.splice(lockIdx + 1, 0, "    primary-branch: true");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  // `dev:` exists without a `lock:` mapping — insert the nested block at its top.
  lines.splice(devStart + 1, 0, ...lockBlock);
  return `${lines.join("\n").trimEnd()}\n`;
}

export interface DevelopmentWorkflowInjectionInput {
  agentsMarkdown?: string;
  claudeMarkdown?: string;
  configYaml?: string;
}

export interface DevelopmentWorkflowInjectionPlan {
  agentsMarkdown: string;
  claudeMarkdown: string;
  configYaml: string;
  block: string;
}

export function planDevelopmentWorkflowInjection(
  input: DevelopmentWorkflowInjectionInput,
): DevelopmentWorkflowInjectionPlan {
  return {
    agentsMarkdown: upsertDevelopmentWorkflowBlock(input.agentsMarkdown ?? ""),
    claudeMarkdown: upsertDevelopmentWorkflowBlock(input.claudeMarkdown ?? ""),
    configYaml: activatePrimaryBranchLockConfig(input.configYaml ?? ""),
    block: DEVELOPMENT_WORKFLOW_BLOCK,
  };
}
