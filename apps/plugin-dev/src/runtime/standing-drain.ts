import type { StandingDrainConfig } from "../core/config.js";

/** The session-local operations needed to maintain one project's drain policy. */
export interface StandingDrainMaintenance {
  standing(): StandingDrainConfig | null;
  registration(): Promise<{ readonly standing?: boolean } | null>;
  register(config: StandingDrainConfig): Promise<unknown>;
  renew(): Promise<unknown>;
}

/**
 * Apply one MCP-session maintenance pass.
 *
 * Registration remains opt-in: without a standing declaration this only runs
 * the ordinary renewal path for a drain an operator explicitly started. With a
 * declaration, absence means the same idempotent registration action exposed by
 * the MCP `drain` tool, so a new session repairs a lapsed predecessor without a
 * manual stop/start pair.
 */
export async function maintainStandingDrain(
  maintenance: StandingDrainMaintenance,
): Promise<unknown> {
  const standing = maintenance.standing();
  if (standing !== null) {
    const held = await maintenance.registration();
    if (held === null || held.standing !== true) await maintenance.register(standing);
  }
  return maintenance.renew();
}
