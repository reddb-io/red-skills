export const DEVELOPMENT_WORKFLOW_HEADING = "Development workflow";

export const DEVELOPMENT_WORKFLOW_BLOCK = `## ${DEVELOPMENT_WORKFLOW_HEADING}

- One-off concrete work goes through \`/go "<demand>"\` (ADR 0081): it mints a disposable \`lane:go\` issue, works in a castle worker under the shared \`.red/tmp/workers/\` root with \`current.kind=go\`, runs the shared gate, and brings back a PR. Route the structured backlog through \`/afk\`; put a parked issue back in the queue with \`/retake\`.
- When working by hand instead (e.g. a slice the maintainer decided to land manually), work in an isolated worktree under \`.red/tmp/worktrees/manual/<slug>\`; do not create sibling worktrees outside the repo.
- Create task branches with \`git worktree add .red/tmp/worktrees/manual/<slug> -b <branch> origin/main\`, not with \`git checkout -b\` or \`git switch -c\` in the primary checkout.
- Check out an EXISTING branch against the REMOTE ref: \`git fetch origin <branch> && git worktree add .red/tmp/worktrees/manual/<slug> -B <branch> origin/<branch>\`. Never the bare \`git worktree add <dir> <branch>\` — that resolves the LOCAL ref, which can trail \`origin/<branch>\`, so the work is built on a stale tip and the push comes back \`non-fast-forward\`.
- Commit the worktree, push the branch early, open a PR, monitor its checks, then merge it or park the issue/PR for \`/hitl\`.
- The agent never switches the primary checkout's branch; only the user does. With \`plugins.dev.enabled: true\`, the dev command proxy blocks agent-created worktrees outside registered \`.red/tmp/\` lanes and primary-checkout branch movement.`;

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

/**
 * Ensure the canonical, namespaced primary-branch guard flag
 * `plugins.dev.lock.primary-branch: true` exists in `.red/config.yaml`.
 *
 * Canonical placement is the namespaced `plugins.dev.*` block (ADR 0042 / PR
 * #697: the whole `plugins.dev.*` block folds onto the `dev.*` accessors and the
 * namespaced form wins over the legacy top-level `dev:` one). This writer never
 * touches a legacy top-level `dev.lock.*` it finds — migrating/removing that is
 * the doctor's gated `--fix` job, not setup's.
 */
export function activatePrimaryBranchLockConfig(yaml: string): string {
  const normalised = yaml.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const flag = "      primary-branch: true";

  // No `plugins:` block at all — append the whole nested block.
  const pluginsStart = lines.findIndex((line) => /^plugins:\s*(?:#.*)?$/.test(line));
  if (pluginsStart === -1) {
    const prefix = lines.join("\n").trimEnd();
    const block = ["plugins:", "  dev:", "    lock:", flag].join("\n");
    return `${prefix}${prefix.length > 0 ? "\n\n" : ""}${block}\n`;
  }

  // Bound the `plugins:` block (until the next top-level key).
  let pluginsEnd = lines.length;
  for (let i = pluginsStart + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      pluginsEnd = i;
      break;
    }
  }

  // Find `  dev:` inside `plugins:`.
  let devIdx = -1;
  for (let i = pluginsStart + 1; i < pluginsEnd; i += 1) {
    if (/^ {2}dev:\s*(?:#.*)?$/.test(lines[i]!)) {
      devIdx = i;
      break;
    }
  }
  // No `plugins.dev:` — insert the dev/lock/flag block at the top of `plugins:`.
  if (devIdx === -1) {
    lines.splice(pluginsStart + 1, 0, "  dev:", "    lock:", flag);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  // Bound `plugins.dev:` (until a line indented <= 2 spaces).
  let devEnd = pluginsEnd;
  for (let i = devIdx + 1; i < pluginsEnd; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^ {0,2}\S/.test(line)) {
      devEnd = i;
      break;
    }
  }

  // Find `    lock:` inside `plugins.dev:`.
  let lockIdx = -1;
  for (let i = devIdx + 1; i < devEnd; i += 1) {
    if (/^ {4}lock:\s*(?:#.*)?$/.test(lines[i]!)) {
      lockIdx = i;
      break;
    }
  }
  // No `plugins.dev.lock:` — insert it at the top of `plugins.dev:`.
  if (lockIdx === -1) {
    lines.splice(devIdx + 1, 0, "    lock:", flag);
    return `${lines.join("\n").trimEnd()}\n`;
  }

  // Bound `plugins.dev.lock:` (until a line indented <= 4 spaces).
  let lockEnd = devEnd;
  for (let i = lockIdx + 1; i < devEnd; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^ {0,4}\S/.test(line)) {
      lockEnd = i;
      break;
    }
  }
  // Ensure `      primary-branch: true` under the existing `plugins.dev.lock:`.
  for (let i = lockIdx + 1; i < lockEnd; i += 1) {
    if (/^ {6}primary-branch:\s*/.test(lines[i]!)) {
      lines[i] = flag;
      return `${lines.join("\n").trimEnd()}\n`;
    }
  }
  lines.splice(lockIdx + 1, 0, flag);
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
