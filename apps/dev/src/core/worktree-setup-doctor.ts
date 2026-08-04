/**
 * Read-only audit of the repository-owned AFK worktree setup declaration.
 * Facts are injected so `/red-doctor` can compare config with package metadata
 * without running the command it is inspecting (#3268).
 */

export type SetupPackageManager = "pnpm" | "bun" | "yarn" | "npm";
export type SetupHookManager = "lefthook" | "husky";
export type SetupVerdict = "ok" | "error";

export interface WorktreeSetupFacts {
  readonly declared: readonly string[];
  readonly packageManager?: SetupPackageManager;
  readonly hookManagers: readonly SetupHookManager[];
}

export interface WorktreeSetupFinding {
  readonly command?: string;
  readonly verdict: SetupVerdict;
  readonly reason: string;
}

export interface WorktreeSetupReport {
  readonly verdict: SetupVerdict;
  readonly findings: readonly WorktreeSetupFinding[];
}

const PACKAGE_MANAGERS: readonly SetupPackageManager[] = ["pnpm", "bun", "yarn", "npm"];

function invokedPackageManager(command: string): SetupPackageManager | undefined {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  return PACKAGE_MANAGERS.find((manager) => tokens[0] === manager);
}

function hookOptOutMissing(command: string, manager: SetupHookManager): boolean {
  if (/(^|\s)--ignore-scripts(?:\s|$)/.test(command)) return false;
  return manager === "lefthook"
    ? !/(^|\s)LEFTHOOK=0(?:\s|$)/.test(command)
    : !/(^|\s)HUSKY=0(?:\s|$)/.test(command);
}

export function auditWorktreeSetup(facts: WorktreeSetupFacts): WorktreeSetupReport {
  const declared = facts.declared.filter((command) => command.trim() !== "");
  if (declared.length === 0) {
    const manager = facts.packageManager ? `a ${facts.packageManager}` : "an explicit";
    return {
      verdict: "error",
      findings: [
        {
          verdict: "error",
          reason:
            `plugins.dev.afk.setup is undeclared; /red-setup should confirm ${manager} ` +
            "worktree setup command",
        },
      ],
    };
  }

  const findings: WorktreeSetupFinding[] = [];
  let matchedManager = facts.packageManager === undefined;
  for (const command of declared) {
    const invoked = invokedPackageManager(command);
    const reasons: string[] = [];
    if (facts.packageManager && invoked && invoked !== facts.packageManager) {
      reasons.push(`repository uses ${facts.packageManager}, but the setup declaration does not`);
    } else if (facts.packageManager && invoked === facts.packageManager) {
      matchedManager = true;
    }

    if (invoked !== undefined) {
      for (const hook of facts.hookManagers) {
        if (hookOptOutMissing(command, hook)) {
          const variable = hook === "lefthook" ? "LEFTHOOK=0" : "HUSKY=0";
          reasons.push(
            `${hook} is detected but setup declares neither ${variable} nor --ignore-scripts`,
          );
        }
      }
    }

    if (reasons.length > 0) {
      findings.push({ command, verdict: "error", reason: reasons.join("; ") });
      continue;
    }
    const disabled = facts.hookManagers.length > 0
      ? ` and disables ${facts.hookManagers.join("+")} during redirected-hooksPath setup`
      : "";
    findings.push({
      command,
      verdict: "ok",
      reason: invoked
        ? `matches ${invoked}${disabled}`
        : "additional declared setup command",
    });
  }

  if (!matchedManager && facts.packageManager) {
    findings.push({
      verdict: "error",
      reason: `repository uses ${facts.packageManager}, but no setup command invokes it`,
    });
  }
  return {
    verdict: findings.some((finding) => finding.verdict === "error") ? "error" : "ok",
    findings,
  };
}
