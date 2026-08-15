import type {
  RedskilledGithubCustodyForgeView,
  RedskilledGithubCustodyUpstream,
  RedskilledGithubCustodyUpstreamInput,
} from "./github-custody.js";
import { githubHeaders } from "./github-transport.js";

export interface CreateRedskilledGithubCustodyUpstreamOptions {
  readonly origin?: string;
  readonly graphqlEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

/** GitHub's native auto-merge intent is the durable primary merge holder. */
export function createRedskilledGithubCustodyUpstream(
  options: CreateRedskilledGithubCustodyUpstreamOptions = {},
): RedskilledGithubCustodyUpstream {
  const origin = (options.origin ?? "https://api.github.com").replace(/\/+$/, "");
  const graphqlEndpoint = options.graphqlEndpoint ?? `${origin}/graphql`;
  const fetchImpl = options.fetchImpl ?? fetch;

  const observe = async (
    input: RedskilledGithubCustodyUpstreamInput,
  ): Promise<RedskilledGithubCustodyForgeView> => {
    const repository = input.project.projectLabel.split("/").map(encodeURIComponent).join("/");
    const response = await fetchImpl(`${origin}/repos/${repository}/pulls/${input.pullRequest}`, {
      method: "GET",
      headers: githubHeaders(input.credential.secret),
    });
    if (!response.ok) throw new Error(`GitHub custody observation failed with HTTP ${response.status}`);
    return pullRequestView(await response.json());
  };

  return {
    observe,
    async arm(input) {
      const repository = input.project.projectLabel.split("/").map(encodeURIComponent).join("/");
      const pull = await fetchImpl(`${origin}/repos/${repository}/pulls/${input.pullRequest}`, {
        method: "GET",
        headers: githubHeaders(input.credential.secret),
      });
      if (!pull.ok) throw new Error(`GitHub custody arm lookup failed with HTTP ${pull.status}`);
      const body = await pull.json() as Record<string, unknown>;
      if (body.merged === true || body.merged_at != null) {
        return { forge_state: "merged", native_intent: false };
      }
      const nodeId = typeof body.node_id === "string" ? body.node_id : "";
      if (nodeId === "") throw new Error("GitHub custody cannot arm a pull request without a node identity");
      const response = await fetchImpl(graphqlEndpoint, {
        method: "POST",
        headers: { ...githubHeaders(input.credential.secret), "content-type": "application/json" },
        body: JSON.stringify({
          query: "mutation($pullRequestId:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$pullRequestId,mergeMethod:MERGE}){pullRequest{id}}}",
          variables: { pullRequestId: nodeId },
        }),
      });
      if (!response.ok) throw new Error(`GitHub custody arm failed with HTTP ${response.status}`);
      const answer = await response.json() as { readonly errors?: unknown };
      if (Array.isArray(answer.errors) && answer.errors.length > 0) {
        throw new Error("GitHub refused the native merge intent");
      }
      const refreshed = await observe(input);
      if (refreshed.forge_state === "merged" || refreshed.forge_state === "closed") return refreshed;
      return { ...refreshed, native_intent: true };
    },
  };
}

function pullRequestView(value: unknown): RedskilledGithubCustodyForgeView {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub custody received an invalid pull request");
  }
  const pull = value as Record<string, unknown>;
  if (pull.merged === true || pull.merged_at != null) {
    return { forge_state: "merged", native_intent: false };
  }
  if (pull.state === "closed") return { forge_state: "closed", native_intent: false };
  if (pull.state !== "open") throw new Error("GitHub custody received an unknown pull request state");
  const nativeIntent = pull.auto_merge != null;
  const mergeableState = typeof pull.mergeable_state === "string" ? pull.mergeable_state.toLowerCase() : "unknown";
  const forgeState = pull.mergeable === false || ["blocked", "dirty", "behind"].includes(mergeableState)
    ? "open-blocked" as const
    : pull.mergeable === true && ["clean", "has_hooks", "unstable"].includes(mergeableState)
      ? "open-clean" as const
      : "open-pending" as const;
  return { forge_state: forgeState, native_intent: nativeIntent };
}
