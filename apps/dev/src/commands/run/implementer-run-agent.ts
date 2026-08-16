import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { createSpinStreamProcessor } from "@reddb-io/red-castle/engine";
import { encode } from "@reddb-io/toon";
import type { CastleWorkerLaneBridge } from "../../core/castle-worker-lane-bridge.js";
import type { ConfigValues } from "../../core/config.js";
import { getConfig } from "../../core/config.js";
import type { LaneIdleStallConfig } from "../../core/lane-idle-reaper.js";
import { updateState, workerStatePath } from "../../core/state.js";
import { spinOutcome } from "../../core/worker-outcome.js";
import {
  prepareImplementerEnvironment,
  type ImplementerPluginRoots,
  type PreparedImplementerEnvironment,
} from "../../runtime/implementer-environment.js";
import { makeRunAgent, type RunSettings } from "../../runtime/wire.js";

interface ImplementerRunAgentOptions {
  root: string;
  workerId: string;
  current: { attemptDir: string };
  config: ConfigValues;
  configText: string;
  pluginRoots: ImplementerPluginRoots;
  castleBridge: CastleWorkerLaneBridge;
  sandbox: RunSettings["sandbox"];
  maxIterations?: number;
  laneIdle?: LaneIdleStallConfig;
  sandboxImage?: string;
}

/** Decorate the real runner with the per-attempt implementer projection and metrics. */
export function makeImplementerRunAgent(
  options: ImplementerRunAgentOptions,
): ReturnType<typeof makeRunAgent> {
  const inner = makeRunAgent(
    options.sandbox,
    process.env,
    options.maxIterations,
    options.laneIdle,
    options.sandboxImage,
  );
  const steerFilePath = join(
    options.root,
    ".red",
    "tmp",
    "workers",
    options.workerId,
    "steer.toon",
  );
  let preparedDir = "";
  let prepared: PreparedImplementerEnvironment | undefined;

  return (input) => {
    const spinStream = createSpinStreamProcessor({
      workerLog: {
        append: (record) =>
          options.castleBridge.record(record.kind, record.payload),
      },
      steer: (message) => {
        writeFileSync(steerFilePath, encode({ text: message }), "utf8");
      },
    });
    const attemptDir = input.cwd ?? options.current.attemptDir;
    if (!prepared || preparedDir !== attemptDir) {
      const baseline = Number(
        getConfig(options.config, "afk.implementer.runner_startup_baseline_ms"),
      );
      prepared = prepareImplementerEnvironment({
        attemptDir,
        configText: options.configText,
        pluginRoots: options.pluginRoots,
        ...(Number.isFinite(baseline) && baseline > 0
          ? { historicalRunnerStartupMs: baseline }
          : {}),
      });
      preparedDir = attemptDir;
    }

    const environment = prepared;
    const launchStarted = performance.now();
    let startupRecorded = false;
    const originalOnAgentEvent = input.onAgentEvent;
    const running = inner({
      ...input,
      // Every raw `gh` the inner agent spawns belongs to this Worker. The
      // execution boundary uses this explicit opt-in to install the private
      // PATH shim only for implementer runs, never for maintenance commands.
      githubBoundaryActor: `worker:${options.workerId}`,
      steerFile: steerFilePath,
      onSteerConsumed: (iteration) => {
        void options.castleBridge.record("worker.steer_consumed", { iteration });
      },
      implementer: environment.runtime,
      onAgentEvent: (event) => {
        void spinStream.observe(event).catch(() => {});
        if (!startupRecorded) {
          startupRecorded = true;
          environment.recordRunnerStartup(
            Math.max(0, Math.round(performance.now() - launchStarted)),
          );
          void updateState(workerStatePath(attemptDir), {
            "current.implementer_runner_startup_before_ms":
              environment.metrics.runner_startup_ms.before,
            "current.implementer_runner_startup_after_ms":
              environment.metrics.runner_startup_ms.after,
            "current.implementer_skill_manifest_before_bytes":
              environment.metrics.skill_manifest_bytes.before,
            "current.implementer_skill_manifest_after_bytes":
              environment.metrics.skill_manifest_bytes.after,
          })
            .then(() =>
              options.castleBridge.record("worker.implementer-environment", {
                artifact: "implementer-runtime.toon",
                ...environment.metrics,
              }),
            )
            .catch(() => {});
        }
        originalOnAgentEvent?.(event);
      },
    });
    return running.then((result) => {
      const pattern = spinStream.persistentPattern();
      return pattern === undefined
        ? result
        : { ...result, outcome: spinOutcome(pattern) };
    });
  };
}
