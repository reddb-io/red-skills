/** Translation-only Project surfaces over the public redskilled ACP Agent. */
import type {
  RedskillsProjectAcpSession,
  RedskillsProjectPromptResult,
} from "@reddb-io/redskilled/acp-client";
import {
  mcpControlRoutes,
  mcpToolRoute,
  renderUnservedToolRefusal,
  type McpToolControlOperation,
} from "./core/mcp-tool-routing.js";
import { dispatchInput } from "./mcp-tools/worker.js";

/**
 * The control map, DERIVED from the declared routing table (#4113).
 *
 * A second hand-kept list is how the published `drain` and the daemon's own
 * `project_drain` came to sit in one map with nothing stating which of them the
 * MCP actually publishes. The table publishes; this map only translates.
 */
const CONTROL_TOOL = new Map<string, McpToolControlOperation>([
  // Not a published `rs_dev` tool: the daemon's own spelling of the drain verb
  // (`apps/redskilled/src/project-control.ts`), kept so a caller that speaks
  // the daemon's name reaches the same control call rather than a refusal.
  ["project_drain", "drain"],
  ...mcpControlRoutes(),
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
    if (operation === "status") {
      // The tool declares three scopes and used to answer PROJECT for all of
      // them — a wrong answer wearing a healthy face. Host is served by the
      // daemon's own host_state; worker refuses by name until a method serves
      // it, because a scope silently substituted is worse than one refused.
      if (input.scope === "host") return await session.hostState();
      if (input.scope === "worker") {
        throw new Error(
          'status { scope: "worker" } is not served: worker vitals live in no daemon method yet; ' +
            'read scope "host" and filter its workers, or use scope "project"',
        );
      }
      return await session.control("status");
    }
    return await session.control(operation, controlRequest(input));
  }
  const declared = mcpToolRoute(tool);
  // The first served row: a demand-form dispatch reaches the daemon's own
  // go-dispatch method. The wire deliberately carries ONE field, so the tool
  // arguments the wire cannot express refuse by name — an issue-form dispatch
  // belongs to the registered drain, and mode/runner are the daemon's verdicts
  // on this lane.
  if (declared?.kind === "served" && tool === "worker_dispatch") {
    const parsed = dispatchInput({ ...input });
    if (parsed.issue !== undefined || parsed.mode !== undefined || parsed.runner !== undefined) {
      throw new Error(
        'rs_dev tool "worker_dispatch" serves demand dispatches through the daemon\'s go-dispatch ' +
          "method; a tracked-issue dispatch rides the registered drain (arm /afk), and mode/runner " +
          "are not expressible on the go_dispatch wire",
      );
    }
    return await session.goDispatch(parsed.demand as string);
  }
  // **Refuse by name; never prompt a Worker with the call's own text.** Every
  // remaining published tool is declared `unserved`: the verb lives in no
  // process, so `session.prompt("/queue_status {}")` reached a Worker with no
  // ticket handoff for it, which narrated one line and ended the turn. The
  // caller read a healthy-looking empty envelope and went hunting capacity,
  // sockets and version skew (#4113).
  if (declared?.kind === "unserved") throw new Error(renderUnservedToolRefusal(declared));
  throw new Error(`unsupported ACP Project capability ${JSON.stringify(tool)}`);
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
