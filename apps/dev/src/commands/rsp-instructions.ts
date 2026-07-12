import { renderAmbientSkill, type RspInstructionRunner } from "../../../rsp/src/ambient-skill.js";

function runnerFromArgs(args: readonly string[]): RspInstructionRunner {
  const index = args.indexOf("--runner");
  const runner = index >= 0 ? args[index + 1] : undefined;
  return runner === "claude" ? "claude" : "codex";
}

export function renderRspInstructionsHookOutput(runner: RspInstructionRunner): string {
  const instructions = renderAmbientSkill(undefined, { runner });
  if (runner === "codex") return JSON.stringify({ systemMessage: instructions });
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: instructions,
    },
  });
}

export async function rspInstructionsCommand(args: readonly string[]): Promise<number> {
  const runner = runnerFromArgs(args);
  const instructions = renderAmbientSkill(undefined, { runner });
  process.stdout.write(args.includes("--hook") ? renderRspInstructionsHookOutput(runner) : instructions);
  if (args.includes("--hook")) process.stdout.write("\n");
  return 0;
}
