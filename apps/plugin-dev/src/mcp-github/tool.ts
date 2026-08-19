// The `rs_github` tool surface: ONE passthrough, and nothing behind it.
//
// Every other RedSkills MCP publishes a verb per operation. This one publishes
// the forge's own request shape instead, because the forge already has a
// vocabulary of several hundred endpoints and a per-endpoint tool for each is a
// surface that ages against someone else's API. A method, a path, a body and
// headers cover all of them and go stale against nothing.
//
// The tool holds no credential, no cache and no client. It names the daemon
// method and forwards; the Project's credential profile, the age-stamped cache,
// the coalescing of concurrent identical reads and the durable write outbox are
// the daemon's, and stay there (ADR 0147 §2, ADR 0144 §3, ADR 0132).
import { z } from "zod/v3";
import {
  REDSKILLED_GITHUB_REQUEST_METHODS,
  REDSKILLS_ACP_METHODS,
} from "@reddb-io/protocol-acp";

/**
 * The published name of the cross-plugin GitHub MCP (ADR 0147 rule 2).
 *
 * `rs_github` is not a plugin's own MCP — it is the one every plugin may mount,
 * so the prefix says which family it belongs to on hosts that flatten server
 * names into one namespace.
 */
export const RS_GITHUB_MCP_SERVER_NAME = "rs_github";

/** The one tool. A second one here would be an endpoint catalogue re-growing. */
export const RS_GITHUB_REQUEST_TOOL = "github_request";

/** The daemon method the tool forwards to. Named from the shared registry. */
export const RS_GITHUB_REQUEST_METHOD = REDSKILLS_ACP_METHODS.githubRequest;

/** One published tool: its schema and the daemon method behind it. */
export interface RsGithubTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly method: string;
  readonly inputSchema: Record<string, z.ZodType>;
}

/**
 * Declare the `rs_github` surface.
 *
 * `headers` is published even though the daemon refuses every entry: a caller
 * that sends one gets a named refusal rather than a silent drop, and the field
 * is where a header the gateway later chooses to honour would appear.
 */
export function createRsGithubTools(): RsGithubTool[] {
  return [
    {
      name: RS_GITHUB_REQUEST_TOOL,
      title: "Request the Project's forge",
      description:
        "MUTATING: forward one REST request to the Project's GitHub gateway. An observing method " +
        "(GET, HEAD) is served from the daemon's Project cache and carries the age of what it " +
        "served; concurrent identical reads share one upstream call. A mutating method is " +
        "scheduled through the daemon's durable outbox and answers with its publication receipt. " +
        "Paths are repository-relative — `issues/17` — or the full `repos/<owner>/<repo>/…` form " +
        "of this Project's own repository; another repository is refused.",
      method: RS_GITHUB_REQUEST_METHOD,
      inputSchema: {
        method: z.enum(
          REDSKILLED_GITHUB_REQUEST_METHODS as unknown as [string, ...string[]],
        ),
        path: z.string().min(1),
        body: z.record(z.unknown()).optional(),
        headers: z.record(z.string()).optional(),
      },
    },
  ];
}
