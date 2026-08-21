import { ACP_AGENT_IDS, type AcpAgentId } from "@reddb-io/protocol-acp";
import type { ConfigValues } from "./config.js";

/** A project-level policy that asks every MCP session and the daemon to keep draining. */
export interface StandingDrainConfig {
  /**
   * The child ACP Agent a Worker for this project runs.
   *
   * **An `AcpAgentId`, not a legacy `Runner`** (#4293). The declaration's whole
   * destination is the registration's `--child-agent` token, which the daemon
   * resolves through its Agent catalog and the Worker's argv parser refuses
   * unless it is one of these five. Validating against the older `Runner` union
   * refused `claude-code` — the exact value the first repository to declare a
   * standing drain wrote — and accepted `claude`, `hermes` and `claude-minimax`,
   * none of which the catalog can launch. A vocabulary that admits what the
   * consumer rejects is a validation that reads as one and is not one.
   */
  readonly runner: AcpAgentId;
  readonly target: number;
}

/**
 * Read the opt-in standing drain declaration.
 *
 * Both leaves are required. An incomplete declaration is inert rather than
 * borrowing explicit drain defaults: persistence must be deliberately enabled.
 */
export function readStandingDrain(values: ConfigValues): StandingDrainConfig | null {
  const runner = (values["afk.standing.runner"] ?? "").trim();
  const target = Number.parseInt((values["afk.standing.target"] ?? "").trim(), 10);
  return isStandingRunner(runner) && Number.isInteger(target) && target > 0 ? { runner, target } : null;
}

/** True for a child Agent the daemon's catalog can actually launch. PURE. */
export function isStandingRunner(value: string): value is AcpAgentId {
  return (ACP_AGENT_IDS as readonly string[]).includes(value);
}
