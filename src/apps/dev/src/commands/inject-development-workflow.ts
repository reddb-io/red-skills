import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planDevelopmentWorkflowInjection } from "../core/development-workflow.js";

export interface DevelopmentWorkflowInjectionResult {
  agentsPath: string;
  claudePath: string;
  configPath: string;
  agentsChanged: boolean;
  claudeChanged: boolean;
  configChanged: boolean;
}

function rootFromArgs(args: readonly string[], cwd: string): string {
  const idx = args.indexOf("--root");
  if (idx === -1) return cwd;
  const value = args[idx + 1];
  if (!value) throw new Error("inject-development-workflow: --root requires a path");
  return value;
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeIfChanged(path: string, next: string): boolean {
  const previous = readIfExists(path);
  if (previous === next) return false;
  writeFileSync(path, next, "utf8");
  return true;
}

/**
 * Upsert the canonical development-workflow rules into both agent rule files.
 * The function intentionally creates a missing peer file so AGENTS.md and
 * CLAUDE.md carry the same teach block after every run.
 */
export function injectDevelopmentWorkflowRules(root: string): DevelopmentWorkflowInjectionResult {
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  const configPath = join(root, ".red", "config.yaml");
  const plan = planDevelopmentWorkflowInjection({
    agentsMarkdown: readIfExists(agentsPath),
    claudeMarkdown: readIfExists(claudePath),
    configYaml: readIfExists(configPath),
  });

  mkdirSync(join(root, ".red"), { recursive: true });

  return {
    agentsPath,
    claudePath,
    configPath,
    agentsChanged: writeIfChanged(agentsPath, plan.agentsMarkdown),
    claudeChanged: writeIfChanged(claudePath, plan.claudeMarkdown),
    configChanged: writeIfChanged(configPath, plan.configYaml),
  };
}

export async function injectDevelopmentWorkflowCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const root = rootFromArgs(args, cwd);
  const result = injectDevelopmentWorkflowRules(root);
  stdout.write(
    [
      `inject-development-workflow: AGENTS.md ${result.agentsChanged ? "updated" : "unchanged"}`,
      `inject-development-workflow: CLAUDE.md ${result.claudeChanged ? "updated" : "unchanged"}`,
      `inject-development-workflow: .red/config.yaml ${result.configChanged ? "updated" : "unchanged"}`,
    ].join("\n") + "\n",
  );
  return 0;
}
