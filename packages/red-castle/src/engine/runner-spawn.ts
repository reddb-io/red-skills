export function specialUserRequestBlock(specialRequest: string | undefined): string | null {
  if (!specialRequest) return null;
  return ["---- SPECIAL USER REQUEST ------", specialRequest, "-------------------------------"].join("\n");
}

export interface SpawnArgsInput {
  prompt: string;
  worktree: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface SpawnInvocation {
  command: string;
  args: string[];
}

export function claudeSpawnArgs(input: SpawnArgsInput): SpawnInvocation {
  return {
    command: "claude",
    args: [
      "--model",
      "opus",
      "--effort",
      "medium",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
      "--print",
      input.prompt,
    ],
  };
}

export function codexSpawnArgs(input: SpawnArgsInput & { lastMessagePath: string }): SpawnInvocation {
  const tierArgs = [
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["-c", `model_reasoning_effort=${input.effort}`] : []),
  ];
  return {
    command: "codex",
    args: [
      "exec",
      ...tierArgs,
      "--json",
      "-C",
      input.worktree,
      "--sandbox",
      "danger-full-access",
      "--dangerously-bypass-approvals-and-sandbox",
      "--output-last-message",
      input.lastMessagePath,
      input.prompt,
    ],
  };
}

const exhaustionPattern =
  /usage limit|weekly (limit|cap)|session (limit|exhausted)|quota|rate_limit_error|try again later|\bbalance\b|\b429\b|insufficient.credit/i;

export function isRunnerExhausted(text: string): boolean {
  return exhaustionPattern.test(text);
}
