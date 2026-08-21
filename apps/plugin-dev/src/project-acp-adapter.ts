/** Translation-only Project surfaces over the public redskilled ACP Agent. */
import type {
  RedskillsProjectAcpSession,
  RedskillsProjectPromptResult,
} from "@reddb-io/redskilled/acp-client";

const CONTROL_TOOL = new Map<string, "drain" | "stop" | "status">([
  ["drain", "drain"],
  ["project_drain", "drain"],
  ["project_stop", "stop"],
  ["project_status", "status"],
  ["status", "status"],
]);

/**
 * What a control call may carry. **A control tool with arguments must still be
 * a control call**: routing it to a prompt instead turned `drain {target:2}`
 * into the text `/drain {"target":2}`, which the daemon's verb matcher did not
 * recognise, so the whole thing became "run this prompt in a Worker" and came
 * back as narration with no answer in it.
 */
const CONTROL_ARGUMENTS = new Set([
  "target",
  "runner",
  "scope",
  "registration",
  // The drain budget the operator declared (#4170). Accepted here and carried
  // no further: `enrich` already folded it into the registration, which is the
  // only place the daemon reads it from — a second copy on the control request
  // would be a second answer to "how long is this drain".
  "budget_ms",
  // Read shaping, accepted and ignored: `status` declares them in its schema and
  // the MCP fills the defaults in, so refusing them made the tool unusable —
  // `status { scope: project }` came back refused for a field that changes
  // nothing about what the control surface answers.
  "live_only",
  "fields",
  "worker",
]);

/** Project MCP calls are projections; the adapter never executes a workflow. */
export async function invokeProjectMcp(
  session: RedskillsProjectAcpSession,
  tool: string,
  input: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const operation = CONTROL_TOOL.get(tool);
  if (operation != null) {
    const unsupported = Object.keys(input).filter((key) => !CONTROL_ARGUMENTS.has(key));
    if (unsupported.length > 0) {
      // Refuse loudly rather than degrade to prose. A caller that asked for
      // something the control surface cannot express deserves to be told, not
      // to read a healthy-looking answer that dropped its request.
      throw new Error(
        `the Project control surface cannot express ${JSON.stringify(unsupported.sort())} for ${JSON.stringify(tool)}`,
      );
    }
    if (operation === "status") return await session.control("status");
    return await session.control(operation, controlRequest(input));
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

function controlRequest(input: Readonly<Record<string, unknown>>): {
  target?: number;
  runner?: string;
  registration?: Readonly<Record<string, unknown>>;
} {
  const target = input.target;
  const runner = input.runner;
  // The work a drain carries (#4101): authored here, where an Issue and a ready
  // label mean something, and opaque from the socket onward.
  const registration = input.registration;
  return {
    ...(typeof target === "number" && Number.isInteger(target) && target >= 0 ? { target } : {}),
    ...(typeof runner === "string" && runner.length > 0 ? { runner } : {}),
    ...(registration != null && typeof registration === "object" && !Array.isArray(registration)
      ? { registration: registration as Readonly<Record<string, unknown>> }
      : {}),
  };
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
