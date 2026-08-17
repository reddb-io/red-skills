/** Translation-only Project surfaces over the public redskilled ACP Agent. */
import type {
  RedskillsProjectAcpSession,
  RedskillsProjectPromptResult,
} from "@reddb-io/redskilled/acp-client";

const CONTROL_TOOL = new Map<string, "drain" | "stop" | "status">([
  ["drain", "drain"],
  ["project_stop", "stop"],
  ["project_status", "status"],
  ["status", "status"],
]);

/** Project MCP calls are projections; the adapter never executes a workflow. */
export async function invokeProjectMcp(
  session: RedskillsProjectAcpSession,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const operation = CONTROL_TOOL.get(tool);
  if (operation != null && Object.keys(input).length === 0) {
    if (operation === "status") return await session.control("status");
    return await session.control(operation);
  }
  if (!isPublicCapability(tool)) {
    throw new Error(`unsupported ACP Project capability ${JSON.stringify(tool)}`);
  }
  return await session.prompt(renderCapabilityPrompt(tool, input));
}

/** Minimal deterministic CLI grammar over the same typed ACP projection. */
export async function invokeProjectCli(
  session: RedskillsProjectAcpSession,
  argv: readonly string[],
): Promise<unknown> {
  if (argv[0] !== "project") throw new Error("expected an ACP Project command");
  if (argv.length === 2 && argv[1] === "drain") return await session.control("drain");
  if (argv.length === 2 && argv[1] === "stop") return await session.control("stop");
  if (argv.length === 2 && argv[1] === "status") return await session.control("status");
  if (argv.length === 2 && argv[1] === "cancel") {
    await session.cancel();
    return { status: "cancelled" };
  }
  if (argv[1] === "prompt" && argv.length > 2) {
    return await session.prompt(argv.slice(2).join(" "));
  }
  throw new Error(`unsupported ACP Project command ${JSON.stringify(argv.slice(1))}`);
}

/** Redcode is a generic ACP client; it needs no typed RedSkills extension. */
export function invokeRedcodeProject(
  session: RedskillsProjectAcpSession,
  prompt: string,
): Promise<RedskillsProjectPromptResult> {
  return session.prompt(prompt);
}

function renderCapabilityPrompt(tool: string, input: Readonly<Record<string, unknown>>): string {
  return `/${tool} ${JSON.stringify(input)}`;
}

function isPublicCapability(tool: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(tool) &&
    !tool.startsWith("private_") &&
    !tool.includes("worker_birth") &&
    !tool.includes("daemon_protocol") &&
    !tool.includes("github_client");
}
