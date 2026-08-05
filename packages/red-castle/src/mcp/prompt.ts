export interface CastleMcpPrompt {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

const HELP_DELEGATION =
  "Call the castle MCP's `help` tool.\nFollow its guidance and invoke the returned `next` call.";

/**
 * Discoverability doors for the castle's common operator intents.
 *
 * The bodies deliberately share one delegation instead of restating any
 * operating choreography: `help` is the castle's only live source of it.
 */
export const CASTLE_MCP_PROMPTS: readonly CastleMcpPrompt[] = [
  {
    name: "drain",
    title: "Drain this project's queue",
    description:
      "Find the next action for starting or continuing a project drain.",
    body: HELP_DELEGATION,
  },
  {
    name: "diagnose",
    title: "Diagnose the castle",
    description: "Find the next action for understanding a castle problem.",
    body: HELP_DELEGATION,
  },
  {
    name: "configure",
    title: "Configure the castle",
    description: "Find the next action for changing castle configuration.",
    body: HELP_DELEGATION,
  },
  {
    name: "stop",
    title: "Stop the castle",
    description: "Find the next action for stopping castle work safely.",
    body: HELP_DELEGATION,
  },
];
