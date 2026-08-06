// redskilled-worker-log — the two ends of one wire (#3079).
//
// No daemon-side surface could show what an AFK Worker was logging, and the logs
// were never missing: the herdr plugin, the VS Code extension and
// `redskilled statusline --verbose` all read from the daemon, and the daemon had
// simply never been told anything. Both of its sources were unwired in this lane.
// `publishRedskilledWorkerLogLine` was an exported publisher with ZERO callers,
// and the rehydration fallback is gated on a `log_path` a registration never
// declared — so the daemon's `logLines` map held nothing for a registration-lane
// Worker, whatever it was writing.
//
// This module is both ends, together, because they are one mechanism split by
// timing rather than two features:
//
//   - **Declared** — what a registration says at `project_start` about where its
//     next Worker's output goes. The daemon frames stdout and stderr as TOONL, so
//     the declaration names the same `worker.log.toonl` the project writes.
//   - **Published** — the Worker's own last line, sent on the beat it already
//     keeps. This is the PRIMARY path: it needs no path at all, so it works
//     wherever the log lives. The declaration covers the gap the beat cannot —
//     a Worker whose first line has not landed yet, and a daemon restarted under
//     a Worker that already published one.
//
// **The host's id is not the project's id, and this module is why the difference
// matters.** The daemon keys everything it holds by the id IT minted; the Worker
// names itself with its own `wXXXX` handle. A heartbeat addressed with the
// project's id names a Worker the daemon holds no record of and is answered
// `accepted: false`. So the registration passes the host's id down as
// `REDSKILLED_WORKER_ID` — the one env var that names the daemon's handle for
// this process, beside `RED_AFK_WORKER_ID`, which goes on naming the work's.

import { join } from "node:path";
import { workersDir } from "@reddb-io/shared/red-paths.js";
import { publishRedskilledWorkerLogLine } from "@reddb-io/redskilled/client";
import type { RedskilledMechanicalHealStamp } from "@reddb-io/redskilled/protocol";
import type { RedskilledWorkerDisplay } from "@reddb-io/redskilled/worker-display";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import {
  RED_AFK_SLOT_PLACEHOLDER,
  RED_AFK_WORKER_ID_PLACEHOLDER,
} from "../core/supervisor/launch-template.js";
import { resolveProjectLabel } from "./redskilled-birth.js";

/**
 * The env var carrying the DAEMON's handle for this process.
 *
 * Deliberately not `RED_AFK_WORKER_ID`: that one is the work's own identity, the
 * name its worker directory, its claim comment and every project-side surface
 * are filed under, and overwriting it with the host's would rename the work to
 * satisfy an address. Two ids already exist; this names the second one instead of
 * pretending there is one.
 */
export const REDSKILLED_HOST_WORKER_ID_ENV = "REDSKILLED_WORKER_ID";

/**
 * Where a Worker's output goes, as a template — WHATEVER ITS ORIGIN. PURE.
 *
 * `{{worker_id}}` is the daemon's own fact, so one declaration serves every
 * Worker it ever births and no two of them are handed one file. This is the
 * Worker's disposable structured lane (ADR 0098), so a reader never has to guess
 * between a dated process capture and the lifecycle log.
 *
 * **One namer, because two namers were two lanes** (#3440). `/afk` registered
 * this path while `/go` stamped a dated plain-text file of its own under
 * `.red/tmp/logs/`, so the same Worker shape reached observability in two
 * formats depending on who asked for it. Provenance is a stamp on the worker
 * state — `origin=go`, `current.kind=go` — never a directory name, so nothing
 * about telling the two apart depends on where the bytes land.
 *
 * **Undated on purpose.** The template used to take a `date` it did not read, a
 * fossil of the migration away from date partitioning. A path resolved against
 * the day a long-held registration was BORN is a path that ages — this project's
 * registration has been renewed over 23,900 times — and the Worker that died on
 * 2026-08-06 named a date-dir from 2026-08-05 that the janitor was already
 * reclaiming.
 */
export function workerLogPathTemplate(root: string): string {
  return join(workersDir(root), RED_AFK_WORKER_ID_PLACEHOLDER, "worker.log.toonl");
}

/** What a registration adds to its Workers' environment. PURE. */
export function registrationLaunchEnv(runner?: string): Record<string, string> {
  return {
    [REDSKILLED_HOST_WORKER_ID_ENV]: RED_AFK_WORKER_ID_PLACEHOLDER,
    // The slot the host placed this Worker on. Read in five places
    // (`reconcile.ts`, `process-deps.ts`, the hook env) and, until #3081, never
    // written on this path — so `parseSlot(process.env.RED_AFK_SLOT) ?? 0`
    // resolved every Worker to slot 0 and the per-slot isolation it exists for
    // (retire files, cargo target dirs, hook scoping) collapsed onto one.
    RED_AFK_SLOT: RED_AFK_SLOT_PLACEHOLDER,
    // `RED_AFK_WORKER_ID` is deliberately NOT set here. It names the work's own
    // identity — the worker directory, the claim comment, every project-side
    // surface — and assigning the host's handle to it would rename the work to
    // satisfy an address. The two ids both exist on purpose; #3081's cure is to
    // make attribution read the host's id where the host is the authority, not
    // to collapse one name onto the other.
    //
    // Re-pinned rather than inherited: the passthrough environment may carry an
    // operator's runner from before the registration decided one, and the
    // Worker's detection cascade must read the one this registration states.
    ...(runner == null || runner === "" ? {} : { RED_AFK_RUNNER: runner }),
  };
}

/**
 * Publish one line and what a surface should SHOW, or do nothing at all.
 *
 * Never throws, never blocks the work. The display record is optional because a
 * beat can happen before there is an attempt state to describe — a line with no
 * record is exactly what the daemon held before #3097, and is still better than
 * a record assembled from defaults.
 */
export type WorkerLogLinePublisher = (
  line: string,
  display?: RedskilledWorkerDisplay,
  mechanicalHeal?: RedskilledMechanicalHealStamp,
) => Promise<void>;

export interface WorkerLogLinePublisherOptions {
  /** This checkout, for the one label the daemon keys this project by. */
  readonly root: string;
  /** Defaults to `process.env`; an input only so a test needs no ambient var. */
  readonly env?: Record<string, string | undefined>;
  /** The publish itself, so a test can watch it without a daemon. */
  readonly publish?: typeof publishRedskilledWorkerLogLine;
}

/**
 * The Worker's side of the beat: its last line, published to the host.
 *
 * **A Worker born outside the daemon publishes nothing**, and that is the whole
 * of the gate: no `REDSKILLED_WORKER_ID` means no host record to address, so a
 * directly-invoked `run` stays exactly as silent as it was. There is deliberately
 * no fallback that guesses an id — a heartbeat filed under a guess would either
 * be refused or, worse, land on another Worker's line.
 *
 * **A failure costs the line and never the work.** The daemon may be down, mid-
 * restart, or may have let this Worker go a beat ago (`accepted: false`, the
 * benign race); none of those is a reason to fail the run whose progress the line
 * was describing.
 */
export function createWorkerLogLinePublisher(
  options: WorkerLogLinePublisherOptions,
): WorkerLogLinePublisher | null {
  const env = options.env ?? process.env;
  const workerId = (env[REDSKILLED_HOST_WORKER_ID_ENV] ?? "").trim();
  // Checked BEFORE anything is resolved: a Worker nobody on the host is holding
  // must cost neither a label lookup nor a socket path, on every run that is not
  // one of ours.
  if (workerId === "") return null;

  // Called through, rather than handed over as a default value: a publisher
  // reached only as a reference is one no reader — and no ratchet — can tell from
  // an unused export, which is the whole shape of #3079.
  const publish: typeof publishRedskilledWorkerLogLine = options.publish
    ?? ((paths, heartbeat, config) => publishRedskilledWorkerLogLine(paths, heartbeat, config));
  const paths = resolveRedskilledPaths({ env });
  const projectLabel = resolveProjectLabel(options.root);
  return async (
    line: string,
    display?: RedskilledWorkerDisplay,
    mechanicalHeal?: RedskilledMechanicalHealStamp,
  ): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    try {
      await publish(paths, {
        worker_id: workerId,
        // Clamped by the publisher, on the publisher's side: a runaway log line
        // must not make a heartbeat expensive.
        line: trimmed,
        ...(display == null ? {} : { display }),
        ...(mechanicalHeal == null ? {} : { mechanicalHeal }),
        session_project: projectLabel,
      });
    } catch {
      // The line is evidence; losing evidence must never cost the work.
    }
  };
}
