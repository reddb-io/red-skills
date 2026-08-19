export interface CastleMcpPrompt {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

const HELP_DELEGATION =
  "Call the redskilled MCP's `help` tool.\nFollow its guidance and invoke the returned `next` call.";

/**
 * Discoverability doors for redskilled's common operator intents.
 *
 * The bodies deliberately share one delegation instead of restating any
 * operating choreography: `help` is redskilled's only live source of it.
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
    title: "Diagnose redskilled",
    description: "Find the next action for understanding a redskilled problem.",
    body: HELP_DELEGATION,
  },
  {
    name: "configure",
    title: "Configure redskilled",
    description: "Find the next action for changing project execution configuration.",
    body: HELP_DELEGATION,
  },
  {
    name: "stop",
    title: "Stop project work",
    description: "Find the next action for stopping project work safely.",
    body: HELP_DELEGATION,
  },
];
