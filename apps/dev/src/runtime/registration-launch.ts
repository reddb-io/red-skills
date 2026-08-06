/**
 * registration-launch — the ONE namer for what this project's next Worker runs.
 *
 * **One composition site, because two of them lost a Worker's identity** (#3081).
 * `project_start` assembled an argv inline and stated an env of one entry beside
 * it; `project_resize` assembled a second argv inline and carried the old env
 * forward. Meanwhile `buildProjectLaunchTemplate` — the pure builder that states
 * `RED_AFK_WORKER_ID`, `RED_AFK_SLOT` and `RED_AFK_RUNNER` as the per-birth facts
 * they are — had zero callers. So every registration-lane Worker was born
 * knowing neither the id the host had assigned it nor the slot it occupied, and
 * it minted a second id of its own. The host and the project then held disjoint
 * id spaces for one Worker, and `project_status` reported an empty fleet over a
 * busy one.
 *
 * This module is the seam: the registration lane resolves the published bundle
 * and the log path, and hands both to the pure builder. Nothing else composes a
 * launch.
 */
import type { RedskilledLaunchTemplate } from "@reddb-io/redskilled/launch-template";
import { buildProjectLaunchTemplate } from "../core/supervisor/launch-template.js";
import { publishedBundleArgv } from "./published-entry.js";
import { registrationLaunchEnv } from "./redskilled-worker-log.js";

export interface RegistrationLaunchInput {
  /** The runner the NEXT Worker uses, as this start or this resize decided it. */
  readonly runner: string;
  /** The project's own work selector, carried to the one reader that reads it. */
  readonly selector?: unknown;
  /** Where the NEXT Worker's output goes; a template, carrying `{{worker_id}}`. */
  readonly logPath?: string | null;
  /** The leading argv; defaults to the published bundle's, an input for tests. */
  readonly bundleArgv?: readonly string[];
}

/** Compose the launch a registration or a renewal states. */
export function registrationLaunch(input: RegistrationLaunchInput): RedskilledLaunchTemplate {
  return buildProjectLaunchTemplate({
    bundleArgv: input.bundleArgv ?? publishedBundleArgv(),
    runner: input.runner,
    ...(input.selector ? { slotArgs: ["--selector", JSON.stringify(input.selector)] } : {}),
    // The host's own handle for this process rides alongside the work's id
    // rather than instead of it: a heartbeat is addressed with the daemon's
    // string, and every project-side surface is filed under the same one now
    // that the Worker adopts what the host assigned.
    // Preserve the source of this pin. The launch builder also writes
    // RED_AFK_RUNNER, but without this marker the Worker could report only
    // "env"/"flag" and a project_start registration would override task
    // routes invisibly for its whole lifetime.
    workerEnv: {
      ...registrationLaunchEnv(),
      RED_AFK_RUNNER_ORIGIN: "project_start",
    },
    ...(input.logPath == null ? {} : { logPath: input.logPath }),
  });
}
