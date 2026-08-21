// endpoint — the child ACP Agent endpoint redskilled hands a Worker (ADR 0148).
//
// The endpoint is the one thing that crosses the body-versus-control cut on the
// `acp-worker` argv. redskilled decides WHICH Agent — catalog pins, npm
// integrity, host credentials, adapter provisioning and fallback policy all
// stay on the daemon's side of the boundary — and the Worker receives only the
// resolved stdio command it is authorized to spawn. Both ends therefore spell
// the same shape, and neither of them owns it: the daemon's catalog re-exports
// these names rather than declaring them, so a Worker never has to import the
// catalog to read the endpoint it was handed.
export const ACP_AGENT_IDS = ["redcode", "claude-code", "codex", "pi", "opencode"] as const;

/** The only first-class child Agent identities. */
export type AcpAgentId = (typeof ACP_AGENT_IDS)[number];

/** One resolved child Agent: what to spawn, already chosen by the daemon. */
export interface AcpEndpoint {
  readonly agent: AcpAgentId;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  /**
   * The ACP session mode the Worker must set right after `session/new`.
   *
   * Some Agents take their unattended posture from argv and some take it from a
   * session mode — claude-code-acp parses no argv at all, and `bypassPermissions`
   * is the only door it has (#4278). The mode travels ON the endpoint because
   * the endpoint is already the one thing that crosses the body/control cut:
   * the daemon's catalog decides it, and the Worker applies what it was handed
   * without ever asking which Agent it is holding.
   */
  readonly unattendedSessionMode?: string;
}
