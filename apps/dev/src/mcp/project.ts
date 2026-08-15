// Project registration, drain and resize — the daemon-facing half of the operations surface.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { waitsDir } from "@reddb-io/shared/red-paths.js";
import {
  composeRepair,
  noRepair,
  registrationRepair,
} from "@reddb-io/shared/repair.js";
import { decode as decodeToon } from "@reddb-io/toon";
import {
  planDrain,
} from "@reddb-io/red-castle/engine";
import type {
  ProjectDrainInput,
  ProjectStartInput,
  ProjectResizeInput,
  ProjectStatusOutput,
  WaitStatusInput,
} from "@reddb-io/red-castle/mcp-server";
import { listWaits as listRspWaits } from "../../../rsp/src/wait/registry.js";
import {
  newestInstalledPluginVersion,
  publishedVersionReport,
  readPublishedBundleVersion,
} from "../core/published-version.js";
import * as ghx from "../runtime/gh.js";
import {
  createRedskilledBirthPort,
  redskilledRegistrationRefusal,
} from "../runtime/redskilled-birth.js";
import { workerLogPathTemplate } from "../runtime/redskilled-worker-log.js";
import { registrationLaunch } from "../runtime/registration-launch.js";
import { registrationDeliveryLanes } from "../runtime/registration-delivery.js";
import { attributeProjectWorkers } from "../core/project-attribution.js";
import { migrateToTwoPlayer } from "../runtime/two-player-migration.js";
import {
  afkPaths,
  collectMonitorInputs,
  resolveRepoContext,
} from "../runtime/wire.js";
import {
  auditConfigLoad,
  getConfig,
  loadConfig,
  readStandingDrain,
  readValidationMoments,
  resolveTaskRoute,
} from "../core/config.js";
import { describeValidationMoments } from "../core/validation-moments.js";
import {
  buildRegistrationPollPlan,
  buildRegistrationQuery,
  registrationQueryUnexpressedFacets,
} from "../core/registration-query.js";
import { resolveRepoSlugForDir } from "@reddb-io/shared/project-identity-resolve.js";
import { DEFAULT_FLEET_WIDTH, FLEET_WIDTH_CONFIG_KEY } from "@reddb-io/shared/default-fleet-width.js";

import { resolveConfiguredBase } from "./operations.js";

export function projectActivation(root: string) {
  const config = afkPaths(root).configPath;
  const audit = auditConfigLoad(config, { warn: () => undefined });
  const standing = readStandingDrain(audit.values);
  const configuredTarget = Number.parseInt(getConfig(audit.values, FLEET_WIDTH_CONFIG_KEY), 10);
  return {
    eligible: audit.pluginEnabled,
    project: createRedskilledBirthPort({ root }).projectLabel,
    runner: standing?.runner ?? resolveTaskRoute(audit.values).runner,
    target:
      standing?.target ??
      (Number.isInteger(configuredTarget) && configuredTarget > 0 ? configuredTarget : DEFAULT_FLEET_WIDTH),
    standing: standing !== null,
    config,
  };
}

export async function waitStatusImpl(root: string, input: WaitStatusInput): Promise<unknown> {
  const resultFile = join(waitsDir(root), `${input.id}.toon`);
  try {
    const raw = await readFile(resultFile, "utf8");
    const trimmed = raw.trim();
    if (trimmed) {
      return { id: input.id, status: "finished", result: decodeToon(trimmed) };
    }
  } catch {
    // result file not present — wait is still running or never started
  }
  const active = await listRspWaits(root);
  return { id: input.id, status: "running", waits: active };
}

/**
 * Concretize a `@me` user facet on an MCP-supplied selector before it reaches a
 * producer or a scoped queue preview, so every selector carries a real login
 * (D2: `@me` never survives past the dispatch boundary).
 */
export async function concretizeSelectorUser<T extends { user?: string }>(
  root: string,
  selector: T | undefined,
): Promise<T | undefined> {
  if (!selector || selector.user !== "@me") return selector;
  const context = await resolveRepoContext(root);
  return ghx.resolveSelectorUser(selector, () =>
    ghx.resolveViewerLogin({ cwd: root, repo: context.repo }),
  );
}

/**
 * What the host holds for this project, and which Workers it is running.
 *
 * ADR 0130 Amendment 4 removed the per-project process, so there is no
 * `supervisor:` left to report — the question "is this project being driven"
 * is answered by the REGISTRATION the daemon holds and by the poll it last ran
 * against it (#2909). A daemon that does not answer reports `daemon_reachable:
 * false` rather than an absent registration, because "the host holds nothing"
 * and "the host said nothing" send an operator to opposite places.
 */
export async function projectStatus(root: string): Promise<ProjectStatusOutput> {
  const port = createRedskilledBirthPort({ root });
  const [monitor, registrationState, interactiveReservation] = await Promise.all([
    collectMonitorInputs(root),
    port.registrationState().catch(() => undefined),
    port.interactiveReservation().catch(() => 0),
  ]);
  const held = registrationState?.held;
  const lapse = registrationState?.lapse;
  // No pre-filter: attribution owns the liveness qualification, and a worker
  // liveness cannot prove must land in unattributed, not vanish (#3660).
  const allLiveWorkers = monitor.workers;
  // Attribution is the HOST's, never a pid map of our own: a Worker is ours when
  // the daemon says its project is ours. A stamp for another project — or none
  // at all — lands in the unattributed bucket even when the pid looks familiar.
  //
  // The join works because the two ids are ONE id: the launch declares
  // `RED_AFK_WORKER_ID={{worker_id}}` and the Worker adopts the string the host
  // assigned rather than minting its own (#3081). A predicate that matches
  // nothing across a non-empty Worker set is that wire broken, and it is
  // reported rather than rendered as an idle project.
  // ONE host read for both the ids and their birth instants: the dates are what
  // tell a newborn holding its slot apart from a record outliving its Worker
  // (#3123), and asking twice would date them to two different answers.
  const hostBirths = await port.workerBirths().catch(() => null);
  const attribution = attributeProjectWorkers({
    workers: allLiveWorkers,
    hostWorkerIds: hostBirths == null ? null : Object.keys(hostBirths),
    ...(hostBirths == null ? {} : { hostWorkerBirths: hostBirths }),
  });
  const liveWorkers = attribution.live;
  const unattributedWorkers = attribution.unattributed;
  // The published version comes from the one owner the boot probe also consults
  // (#2809), so a reader replays that answer instead of deriving its own.
  const published = readPublishedBundleVersion();
  const version = publishedVersionReport("", published);
  const delivery = registrationDeliveryLanes({
    registrationArgv: held?.argv,
    publishedVersion: published.version,
    pluginCacheVersion: newestInstalledPluginVersion(),
  });
  const target = held?.target ?? 0;
  const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
  const validationSchedule = describeValidationMoments(readValidationMoments(config));
  const standingStopped = held == null &&
      readStandingDrain(config) !== null &&
      lapse?.standing === true &&
      (lapse.queue_depth ?? 0) > 0
    ? `queue ${lapse.queue_depth}, drain STOPPED — `
    : "";
  // The host's count, not the matched list's: a Worker born a moment ago holds
  // its slot before it has written any project-side state, and a `busy` that
  // waited for that file would read free while the daemon refused to fill it.
  const busy = attribution.busy;
  const registrationAbsence = held != null
    ? null
    : registrationState === undefined
      ? composeRepair({
          state: "the redskilled daemon did not answer, so registration state is unknown",
          repair: noRepair("the daemon must answer before registration can be changed safely"),
        })
      : composeRepair({
          state: standingStopped +
            (lapse?.detail ?? "the host holds no registration for this project and recorded no lapse"),
          repair: registrationRepair(),
        });
  return {
    validation_schedule: validationSchedule,
    registration: {
      held: held != null,
      daemon_reachable: registrationState !== undefined,
      project: port.projectLabel,
      socket: port.socketPath,
      selector: held?.selector ?? "",
      target,
      renewal: held?.renewal ?? "unknown",
      renew_by: held?.renew_by ?? "",
      renewals: held?.renewals ?? 0,
      lapsed_at: held == null ? (lapse?.at ?? "") : "",
      reason: registrationAbsence?.prose ?? "",
      ...(registrationAbsence == null
        ? {}
        : {
            repair: registrationAbsence.repair,
            ...(registrationAbsence.repair === "none"
              ? { repair_reason: registrationAbsence.repair_reason }
              : {}),
          }),
      launch_revision: held?.launch_revision ?? 0,
      bundle_version: delivery.bundle_version,
      plugin_cache_version: delivery.plugin_cache_version,
      ...(held?.last_poll ? { last_poll: held.last_poll } : {}),
      ...(version.published_version ? { published_version: version.published_version } : {}),
    },
    birth_latch: registrationState?.birthLatch ?? null,
    slots: {
      busy,
      free: Math.max(0, target - busy),
      parked: 0,
      total: target,
      interactive_reservation: interactiveReservation,
    },
    live_workers: liveWorkers.map((worker) => ({
      id: worker.state.worker_id,
      pid: worker.state.pid,
      issue: String(worker.state.current.number),
      activity: worker.state.current.activity,
      origin: worker.state.origin ?? "afk",
    })),
    unattributed_workers: unattributedWorkers.map((worker) => ({
      id: worker.state.worker_id,
      pid: worker.state.pid,
      issue: String(worker.state.current.number),
      activity: worker.state.current.activity,
      origin: worker.state.origin ?? "afk",
    })),
    ...(attribution.warnings.length > 0 ? { warnings: [...attribution.warnings] } : {}),
  };
}

/**
 * The one string this project hands the daemon as its work query.
 *
 * **A tracker query, because the daemon hands it to the tracker.** It used to be
 * this project's own JSON selector shape — one encoding for two readers, which
 * looked like the frugal choice and was the defect: the daemon carries the
 * string verbatim (ADR 0130 rule 3), so it asked GitHub to search for `{}`, got
 * an answer about nothing, and every registered project sat at a depth that
 * birthed no Worker (#2974). The JSON still travels, in the argv, to the one
 * reader that can read it — the Worker.
 */
function encodeRegistrationSelector(repo: string, selector: ProjectStartInput["selector"]): string {
  return buildRegistrationQuery({ repo, selector });
}

/** What the operator is told about a start that could not carry everything. */
function startWarnings(input: ProjectStartInput, unexpressed: readonly string[]): string[] {
  const warnings: string[] = [];
  if (input.base !== undefined) {
    warnings.push(
      `the base branch ${JSON.stringify(input.base)} does not travel in a registration yet; ` +
        `a Worker born from it will use this project's configured trunk`,
    );
  }
  if (unexpressed.length > 0) {
    warnings.push(
      `the ${unexpressed.join(" and ")} facet(s) cannot be expressed as a tracker query, so the host counts this ` +
        `project's queue without them and may see more work than the selector matches; the Worker still narrows to ` +
        `the selector it is launched with`,
    );
  }
  return warnings;
}

/**
 * Start work on this project — by REGISTERING it, not by launching it.
 *
 * ADR 0130 Amendment 4's two-player model, from the operator's side: **the MCP
 * registers, the daemon drives.** The project's presence on the machine is the
 * record the daemon holds — a repository identity, an opaque selector, an opaque
 * argv and a target width — and beginning work creates no process of the
 * project's own. The runner, the work scope and the base branch are still the
 * whole request; what changed is who is handed them.
 *
 * **A daemon that does not answer refuses the start** (ADR 0130 rule 6). Falling
 * back to a process of the project's own would put a demand producer on the
 * machine that no host admitted, no host counts and no host can stop — precisely
 * the shape the registration exists to end.
 */
export async function projectStart(
  root: string,
  rawInput: ProjectStartInput,
  options: { readonly standing?: boolean } = {},
) {
  const input: ProjectStartInput = {
    ...rawInput,
    ...(rawInput.selector
      ? { selector: await concretizeSelectorUser(root, rawInput.selector) }
      : {}),
  };
  // A project already registered is refused by the DAEMON, which is the one
  // party that can see the record — a pre-check of our own would be a second
  // opinion racing the authority (ADR 0130 Amendment 4).
  const port = createRedskilledBirthPort({ root });
  // ADR 0130 Amendment 6 (#2910): registering is the boundary between a machine
  // that still carries a per-project runtime and one in the two-player model, so
  // the one-time carry-across runs exactly here — before anything this project
  // registers, which is the very thing a leftover runtime would collide with.
  // Stamped, idempotent, and INERT until an operator declares the era with
  // `RED_TWO_PLAYER_CUTOVER=1`: an undeclared era must never stop a runtime the
  // operator is still relying on.
  await migrateToTwoPlayer(root, {
    deps: {
      projectLabel: () => port.projectLabel,
      // The host's own answer to "which Workers are mine", so a Worker it already
      // holds is never re-adopted and a Worker it does not hold is named rather
      // than assumed — re-adoption is confirmed against host state, never claimed.
      hostWorkers: async () =>
        new Map((await port.workerIds()).map((workerId) => [workerId, port.projectLabel])),
      readopt: async (workerId) => (await port.workerIds()).includes(workerId),
    },
  }).catch(() => undefined);
  // A host that does not answer is the FIRST refusal, ahead of anything this
  // project could get wrong about itself: an operator whose daemon is down must
  // be told that, not told about their remote (ADR 0130 rule 6).
  try {
    await port.reach();
  } catch (err) {
    throw new Error(redskilledRegistrationRefusal(port.socketPath, err));
  }
  // Which tracker this project's queue lives in — resolved HERE, because the
  // daemon may not learn what a checkout is (rule 3) and a query without a
  // `repo:` term counts every repository the host token can see. From the
  // `origin` remote rather than the tracker CLI: starting work must not wait on
  // a network call, and a checkout with no remote has no queue to register for.
  const repo = resolveRepoSlugForDir(root);
  if (repo == null) {
    throw new Error(
      `this checkout has no \`origin\` remote, so there is no tracker to count its queue in: the host polls the ` +
        `query a registration hands it, and a project that names no repository would either count nothing or ` +
        `count every repository the host token can see`,
    );
  }
  const selector = encodeRegistrationSelector(repo, input.selector);
  const warnings = startWarnings(input, registrationQueryUnexpressedFacets(input.selector));
  // Where this project's Workers write their output, and how each one addresses
  // the host it must publish its last line to (#3079). Declared HERE because a
  // registration is the only thing this lane ever tells the daemon: a project
  // that states neither births Workers whose logs no surface can show, which is
  // exactly how the herdr plugin, the VS Code extension and the verbose
  // statusline all came to report a Worker with nothing to say.
  const logPathTemplate = workerLogPathTemplate(root);

  // What runs when a Worker is born for this project — resolved from the
  // PUBLISHED bundle rather than from this process's own entry (#2808), so a
  // registration made from a stale plugin cache never commits the host to an
  // older Worker than the one this project publishes.
  //
  // Composed by the ONE namer (#3081). The argv used to be assembled here and
  // the env stated separately, so the env carried only the host's log handle
  // while the three vars a Worker needs to know who and where it is — its id,
  // its slot and its runner — lived in a builder nothing called. A Worker born
  // without its id minted a second one, and no surface could join the two.
  const launch = registrationLaunch({ runner: input.runner, selector: input.selector, logPath: logPathTemplate });
  // A Worker's death is the daemon's authoritative liveness verdict. Run one
  // boot-only reconciliation before another birth can consume the freed slot,
  // so a claim whose pid died during setup cannot leave `running` stranded.
  // This remains project-authored work: the daemon carries the hook without
  // learning what a claim, label, branch or queue lane means.
  const reconciliationLaunch = registrationLaunch({ runner: input.runner, logPath: logPathTemplate });
  const workerDeathHook = {
    ...reconciliationLaunch,
    argv: [...reconciliationLaunch.argv, "--boot-only"],
    mode: "sync" as const,
    deadline_ms: 120_000,
  };

  let registered;
  try {
    // Where a Worker runs, stated rather than derived: the daemon owns the demand
    // loop (ADR 0130 Amendment 4), so it births the Worker itself, and a host that
    // had to work out a working directory would have to know what a checkout looks
    // like — the one thing rule 3 forbids.
    registered = await port.register({
      selector,
      queue_poll: buildRegistrationPollPlan({ repo, selector: input.selector }),
      argv: [...launch.argv],
      workspace_path: root,
      trunk: { remote: "origin", branch: resolveConfiguredBase(root) },
      // Both halves of the env come from the ONE composer (#3081): the host's log
      // handle it carries through `registrationLaunchEnv`, and the per-birth facts
      // — the runner this start decided, the slot the host places the Worker on
      // (#3118) and the worker id it assigns — that the pure builder re-pins.
      env: launch.env ?? {},
      ...(launch.log_path == null ? {} : { log_path: launch.log_path }),
      hooks: { "worker-death": workerDeathHook },
      target: input.target,
      ...(options.standing === true ? { standing: true } : {}),
    });
  } catch (err) {
    throw new Error(redskilledRegistrationRefusal(port.socketPath, err));
  }

  return {
    status: "registered",
    project: registered.project_label,
    target: registered.target,
    runner: input.runner,
    selector: registered.selector,
    argv: [...registered.argv],
    socket: port.socketPath,
    renew_by: registered.renew_by,
    // Reported rather than assumed: an operator who cannot see a Worker's output
    // needs to know which path was declared for it, and a registration answering
    // with none is the defect rather than a Worker that says nothing.
    log_path: registered.log_path ?? null,
    ...(input.selector ? { work_selector: input.selector } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    // Stated, never swallowed: the frozen contract carries no environment, and a
    // trunk override travels to a Worker in one. Naming it here keeps a dropped
    // override visible to the operator who asked for it. The unexpressed facets
    // ride the same list, so a host depth wider than the selector's real pool is
    // an answer the operator already has rather than a contradiction they find.
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function registrationRunner(registration: {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): string | undefined {
  const fromEnv = registration.env?.RED_AFK_RUNNER;
  if (fromEnv) return fromEnv;
  const flag = registration.argv.lastIndexOf("--runner");
  const fromArgv = flag >= 0 ? registration.argv[flag + 1] : undefined;
  return fromArgv === "" ? undefined : fromArgv;
}

/**
 * Ensure this project's queue is draining, whatever safe state already stands.
 *
 * The pure planner owns the decision and difference report. This adapter only
 * observes the daemon and applies the named actions. A target-only resize
 * replaces the registration while leaving its Workers alone; if replacement
 * fails, the old registration is restored before the error escapes.
 */
export async function drain(
  root: string,
  input: ProjectDrainInput,
  options: { readonly standing?: boolean } = {},
) {
  const activation = projectActivation(root);
  if ((input.runner === undefined || input.target === undefined) && !activation.eligible) {
    throw new Error(
      `drain defaults are unavailable because ${activation.config} does not declare plugins.dev.enabled: true`,
    );
  }
  const requested = {
    runner: input.runner ?? activation.runner,
    target: input.target ?? activation.target,
  };
  const port = createRedskilledBirthPort({ root });
  try {
    await port.reach();
  } catch (err) {
    throw new Error(redskilledRegistrationRefusal(port.socketPath, err));
  }

  const state = await port.registrationState();
  const held = state.held;
  const currentRunner = held == null ? undefined : registrationRunner(held);
  const plan = planDrain(
    {
      daemon_reachable: true,
      registration:
        held == null
          ? null
          : {
              runner: currentRunner ?? "unknown",
              target: held.target,
            },
      lapsed: held == null && state.lapse != null,
      workers: await port.liveWorkers(),
    },
    requested,
  );

  if (plan.outcome === "refuse") {
    return { ...plan, outcome: "refused" as const };
  }

  let registrationReplaced = false;
  for (const action of plan.actions) {
    if (action.kind === "reach-daemon") {
      await port.reach();
      continue;
    }
    if (action.kind === "register") {
      await projectStart(root, {
        runner: action.runner,
        target: action.target,
      }, options);
      continue;
    }

    if (held == null) throw new Error("drain resize planned without a registration");
    const request = {
      selector: held.selector,
      ...(held.queue_poll == null ? {} : { queue_poll: held.queue_poll }),
      argv: [...held.argv],
      workspace_path: held.workspace_path,
      ...(held.trunk == null ? {} : { trunk: held.trunk }),
      env: { ...held.env },
      ...(held.log_path == null ? {} : { log_path: held.log_path }),
      ...(held.hooks == null ? {} : { hooks: held.hooks }),
      target: action.target,
      ...(options.standing === true || held.standing === true ? { standing: true } : {}),
      renew_within_ms: held.renew_within_ms,
    };
    await port.deregister();
    try {
      await port.register(request);
    } catch (err) {
      await port.register({ ...request, target: held.target }).catch(() => undefined);
      throw err;
    }
    registrationReplaced = true;
  }

  // A standing policy may be declared over an already-running explicit drain.
  // Restate that record without stopping its Workers so daemon recovery sees the
  // new policy even when runner and target were already identical.
  if (held != null && options.standing === true && held.standing !== true && !registrationReplaced) {
    const request = {
      selector: held.selector,
      ...(held.queue_poll == null ? {} : { queue_poll: held.queue_poll }),
      argv: [...held.argv],
      workspace_path: held.workspace_path,
      ...(held.trunk == null ? {} : { trunk: held.trunk }),
      env: { ...held.env },
      ...(held.log_path == null ? {} : { log_path: held.log_path }),
      ...(held.hooks == null ? {} : { hooks: held.hooks }),
      target: held.target,
      standing: true,
      renew_within_ms: held.renew_within_ms,
    };
    await port.deregister();
    try {
      await port.register(request);
    } catch (err) {
      const { standing: _standing, ...explicit } = request;
      await port.register(explicit).catch(() => undefined);
      throw err;
    }
  }

  return { ...plan, outcome: "applied" as const };
}

/**
 * Give this project's registration back — the other half of stopping work.
 *
 * A stop that could not reach the daemon reports it and does NOT raise, unlike a
 * start: refusing to stop would leave an operator holding a project they cannot
 * put down, and the registration lapses on its own renewal deadline anyway. What
 * is never allowed is silence — the outcome always rides on the answer.
 */
export async function releaseProjectRegistration(root: string) {
  const port = createRedskilledBirthPort({ root });
  try {
    // The Workers go FIRST, and they go through the host. A registration given
    // back while its Workers run leaves work nothing is watching: the demand loop
    // has stopped asking for them, so nobody would ever ask them to stop either.
    // The kill is the daemon's — this only names which of its Workers are ours.
    //
    // A Worker the host no longer names is the outcome asked for, not a failure:
    // between the read and the stop it may have finished, and a teardown that
    // raised on it would leave the registration standing over an empty project.
    const stopped: string[] = [];
    for (const workerId of await port.workerIds()) {
      try {
        if (await port.stop(workerId, "project_stop gave this project's registration back")) {
          stopped.push(workerId);
        }
      } catch {
        // Already gone. The next read is the daemon's, and it agrees.
      }
    }
    return { deregistered: await port.deregister(), project: port.projectLabel, workers_stopped: stopped };
  } catch (err) {
    return {
      deregistered: false,
      project: port.projectLabel,
      warnings: [redskilledRegistrationRefusal(port.socketPath, err)],
    };
  }
}

/**
 * Re-aim this project's work by RESTATING its launch, not by messaging a process.
 *
 * ADR 0130 Amendment 5: the launch is the one part of a registration a renewal
 * may restate, so a runner swap rides the message a live session already sends
 * and the daemon holds it as the launch for the NEXT Worker. The width lives in
 * the registration itself and a renewal does not carry it, so a target change is
 * reported as unapplied rather than silently dropped — a resize that answered
 * "resized" while changing nothing is the failure this states out loud.
 */
export async function projectResize(root: string, rawInput: ProjectResizeInput) {
  const input: ProjectResizeInput = {
    ...rawInput,
    ...(rawInput.selector
      ? { selector: await concretizeSelectorUser(root, rawInput.selector) }
      : {}),
  };
  const port = createRedskilledBirthPort({ root });
  const held = await port.registration().catch(() => undefined);
  if (held == null) {
    throw new Error(
      held === undefined
        ? redskilledRegistrationRefusal(port.socketPath, new Error("the host did not answer"))
        : "this project holds no registration to re-aim; use project_start to register it",
    );
  }

  let directive: "not-requested" | "restated" = "not-requested";
  const warnings: string[] = [];
  if (input.runner !== undefined) {
    // All-or-nothing, as the amendment requires: the argv is restated whole, and
    // the env and the log path travel with it, so the next Worker is never half
    // one tick's decision and half an older one. Restated through the SAME namer
    // the registration used (#3081) — a resize that rebuilt the argv by hand and
    // carried the old env forward is how a launch came to be half-composed, and
    // a restatement that omitted the log path would clear it outright.
    //
    // RESTATED from the namer, never carried from `held` (#3440): the held path
    // is whatever this registration said when it was first registered, and this
    // project's has been renewed over 23,900 times since. Preferring it is how a
    // registration goes on handing out a path from the day it was born — the
    // exact way a Worker that died on 2026-08-06 named a 2026-08-05 date-dir the
    // janitor was already reclaiming.
    await port.restateLaunch(
      registrationLaunch({
        runner: input.runner,
        selector: input.selector,
        logPath: workerLogPathTemplate(root),
      }),
    );
    directive = "restated";
  }
  if (input.target !== undefined && input.target !== held.target) {
    warnings.push(
      `the target ${input.target} does not travel on a renewal; this project stays registered at ` +
        `${held.target} until it is registered again (ADR 0130 Amendment 5)`,
    );
  }
  return {
    status: "resized",
    directive,
    ...(input.target !== undefined ? { target: input.target } : {}),
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.selector ? { selector: input.selector } : {}),
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
