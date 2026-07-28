// fleet-scope — cgroup isolation for the fleet supervisor (#2697).
//
// A fleet spawned with no cgroup of its own inherits the caller's. Launched from
// a terminal — the normal case — that is the terminal emulator's scope, so every
// worker, every gate `pnpm install`, and every vitest fork is charged to the
// terminal. `systemd-oomd` kills the LARGEST cgroup under pressure, which is then
// the terminal's scope: the kill lands on every terminal window and agent session
// instead of on the workload that caused the pressure.
//
// The cure is to create the scope AT LAUNCH — moving a running process between
// cgroups does not move its existing memory charge — by running the supervisor
// under `systemd-run --user --scope`. Every descendant inherits that scope, so
// oomd's pressure kill is scoped to the fleet.
//
// This module is pure planning: it decides the argv prefix from injected probes
// and settings. The impure probe lives in `detectFleetScopeProbes`.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { getConfig, type ConfigValues } from "../core/config.js";

/** Environment kill-switch: `RED_AFK_FLEET_SCOPE=off` launches unscoped. */
export const FLEET_SCOPE_ENV = "RED_AFK_FLEET_SCOPE";
/** Environment override for the scope's `MemoryHigh` property. */
export const FLEET_SCOPE_MEMORY_HIGH_ENV = "RED_AFK_FLEET_SCOPE_MEMORY_HIGH";

export interface FleetScopeProbes {
  /** `process.platform` — cgroup scopes are Linux-only. */
  platform: NodeJS.Platform;
  /** `systemd-run` on PATH, or null when the binary is absent. */
  systemdRun: string | null;
  /** True when a systemd `--user` session is reachable. */
  userSession: boolean;
}

export interface FleetScopeSettings {
  /** False disables isolation entirely (config or env kill-switch). */
  enabled: boolean;
  /** `MemoryHigh` value for the scope; empty string sets no property. */
  memoryHigh: string;
}

export interface FleetScopePlan {
  /** True when the supervisor runs inside its own transient scope. */
  isolated: boolean;
  command: string;
  args: string[];
  /** The transient unit name, only when isolated. */
  unit?: string;
  /** Why isolation was skipped. Always set when `isolated` is false — an
   * unisolated launch is never silent. */
  warning?: string;
}

/**
 * Read the fleet-scope settings, env kill-switch winning over `.red/config.yaml`.
 */
export function readFleetScopeSettings(
  config: ConfigValues,
  env: NodeJS.ProcessEnv = process.env,
): FleetScopeSettings {
  const override = (env[FLEET_SCOPE_ENV] ?? "").trim().toLowerCase();
  const configured = getConfig(config, "afk.fleet.scope.enabled").trim().toLowerCase() !== "false";
  const enabled = override === "" ? configured : !["off", "false", "0", "no"].includes(override);
  const memoryHigh =
    (env[FLEET_SCOPE_MEMORY_HIGH_ENV] ?? "").trim() ||
    getConfig(config, "afk.fleet.scope.memory_high").trim();
  return { enabled, memoryHigh };
}

function which(binary: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Probe the host for transient-scope support. A systemd `--user` session is
 * proven by its private socket under `XDG_RUNTIME_DIR`, so no subprocess runs
 * on the launch path.
 */
export function detectFleetScopeProbes(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): FleetScopeProbes {
  if (platform !== "linux") return { platform, systemdRun: null, userSession: false };
  const runtimeDir = (env.XDG_RUNTIME_DIR ?? "").trim();
  const userSession = runtimeDir !== "" && existsSync(join(runtimeDir, "systemd", "private"));
  return { platform, systemdRun: which("systemd-run", env), userSession };
}

/**
 * Derive the transient unit name from the fleet name, so two named fleets get
 * two scopes. `salt` (the launcher pid) keeps a relaunch from colliding with the
 * previous launch's still-registered unit.
 */
export function fleetScopeUnitName(fleet: string, salt: string | number): string {
  const slug = (fleet || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "default";
  return `red-fleet-${slug}-${salt}.scope`;
}

export interface PlanFleetScopeOptions {
  fleet: string;
  command: string;
  args: readonly string[];
  settings: FleetScopeSettings;
  probes: FleetScopeProbes;
  /** Disambiguator for the unit name; the launcher pid in production. */
  salt: string | number;
}

/**
 * Plan the launch argv. When the host supports it, the supervisor runs under a
 * transient `red-fleet-<name>-<salt>.scope` with `Delegate=yes` and the
 * configured `MemoryHigh`; otherwise the original command is returned unchanged
 * WITH a warning, never a silent downgrade.
 */
export function planFleetScope(opts: PlanFleetScopeOptions): FleetScopePlan {
  const direct = { isolated: false as const, command: opts.command, args: [...opts.args] };
  if (!opts.settings.enabled) {
    return { ...direct, warning: `fleet cgroup isolation disabled by config (${FLEET_SCOPE_ENV}/afk.fleet.scope.enabled); the fleet shares the caller's cgroup` };
  }
  if (opts.probes.platform !== "linux") {
    return { ...direct, warning: `fleet cgroup isolation is Linux-only (platform=${opts.probes.platform}); the fleet shares the caller's cgroup` };
  }
  if (!opts.probes.systemdRun) {
    return { ...direct, warning: "fleet cgroup isolation unavailable: systemd-run is not on PATH; the fleet shares the caller's cgroup and a memory-pressure kill will hit the whole session" };
  }
  if (!opts.probes.userSession) {
    return { ...direct, warning: "fleet cgroup isolation unavailable: no systemd --user session; the fleet shares the caller's cgroup and a memory-pressure kill will hit the whole session" };
  }

  const unit = fleetScopeUnitName(opts.fleet, opts.salt);
  const scopeArgs = [
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    `--unit=${unit}`,
    "--property=Delegate=yes",
  ];
  if (opts.settings.memoryHigh) scopeArgs.push(`--property=MemoryHigh=${opts.settings.memoryHigh}`);
  return {
    isolated: true,
    unit,
    command: opts.probes.systemdRun,
    args: [...scopeArgs, "--", opts.command, ...opts.args],
  };
}
