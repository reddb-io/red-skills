import { isRunner, type Runner } from "../types/runner.js";
import type { ConfigValues } from "./config.js";

/** A project-level policy that asks every MCP session and the daemon to keep draining. */
export interface StandingDrainConfig {
  readonly runner: Runner;
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
  return isRunner(runner) && Number.isInteger(target) && target > 0 ? { runner, target } : null;
}
