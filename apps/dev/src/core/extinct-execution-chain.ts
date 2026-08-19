// extinct-execution-chain — the second crossing on the extinction ratchet: the
// surfaces ADRs 0147, 0148 and 0149 retire (Spec #4007, issue #4009).
//
// The first crossing (ADR 0130) ran to zero, which is why
// `EXTINCT_SOURCE_BASELINE` stood empty. This one starts at TODAY'S COUNT.
// Nothing here is deleted yet: `red-skills-dev` still routes 36 commands, the
// dev bundle is still a Worker body, the janitor still sweeps a human's
// checkout, and 97 modules still name `red-castle`. Declaring the inventory
// BEFORE the deletion is what makes the deletion a ratchet rather than a hope —
// a slice may lower a count, and a slice that raises one is reintroducing the
// surface the ADR retired.
//
// **A COUNT IS A DEBT WITH A NUMBER ON IT.** Each entry pairs the noun with what
// it owned and names the route that replaced it — `rs_dev` and the other Plugin
// MCPs for workflow verbs, `redskilled` for process lifecycle, `@reddb-io/worker`
// for the Worker body, and the daemon's own workspace and evidence lanes for
// everything the janitor used to fear.
//
// The three surviving surfaces are deliberately NOT reddened, because a ratchet
// that reds the replacement teaches the next slice to rename the wrong thing:
// the `redskilled` binary and its own `cli.ts`, the daemon's `launch-template.ts`
// and its `reclaim.ts`, and rsp's resident vocabulary (`resident-core`,
// `resident-client`, `resident-server`) whose code ADR 0147 keeps for the
// fold-in.
import type { ExtinctName, ExtinctSource, ExtinctSourceBaselineEntry } from "./extinct-source-guard.js";

/**
 * The sources ADRs 0147–0149 retire, each with the route that replaced it.
 *
 * A pattern names what the surface OWNED — a binary name, a router's own
 * vocabulary, the run body's exported flags, the janitor's word — never a bare
 * noun that survives elsewhere. `runCommand` and `RunOptions` are absent for
 * exactly that reason: half the repo runs a command, and a pattern that reddened
 * the phrase would teach a worker to rename a shell helper.
 */
export const EXECUTION_CHAIN_SOURCES: readonly ExtinctSource[] = [
  {
    id: "dev-cli-binary",
    noun: "dev-cli",
    what:
      "the `red-skills-dev` binary — a 36-command CLI that duplicated the MCP tools as operator verbs" +
      " and doubled as the body the daemon spawned, so one machine ran two implementations at two versions",
    replacement:
      "the `rs_dev` Plugin MCP for every workflow verb, and the `redskilled` binary — the only shipped" +
      " binary of the execution chain — for birth, provision, stop, `--version`, `--help` and the" +
      " prompt-cadence reads a host hook needs (ADR 0147 rule 1)",
    pattern: /\bred-skills-dev\b|\bdev\.bundle\.min\.mjs\b/,
  },
  {
    id: "dev-cli-router",
    noun: "dev-cli",
    what: "the 36-command router — its command union, its schema, its leading-flag set and the help it raised",
    replacement:
      "the tool schemas `rs_dev` publishes: a command some skill still names becomes a tool of the" +
      " plugin's MCP, and a command no skill names dies with the bundle (ADR 0147 rule 1)",
    pattern: /\b(?:CLI_ROUTER|CliCommand|ParsedCli|parseCli|RUN_SURFACE_LEADING_FLAGS|HelpRequested)\b/,
  },
  {
    id: "dev-worker-run-command",
    noun: "dev-worker-body",
    what:
      "the `run` command — the dev bundle's Worker body, entered as `red-skills-dev run --once` with the" +
      " engine imported in-process, where the daemon could see neither the engine nor the turn",
    replacement:
      "`redskilled acp-worker` running `@reddb-io/worker` (`packages/worker`), the one Worker body:" +
      " agent and sandbox providers, worktree materialisation, gate runner and turn loop in a package the" +
      " daemon embeds (ADR 0148)",
    pattern:
      /\bcommands\/run\b|\b(?:parseRunFlags|RunFlagError|RunDispatchIdentity|resolveRunDispatchIdentity|runNeedsAdmittedFork|shouldSkipBootSweeps|isNamespacedDispatch|probeFleetSupervisor|checkBootGuard|buildProcessDeps|initBootWorkerState|deriveActivity|castleWorktreeUnder|readCapturedWorktreePath)\b/,
  },
  {
    id: "dev-bundle-supervisor",
    noun: "dev-worker-body",
    what:
      "the dev bundle's supervisor state machine — slot state, reaper, heartbeat, resize and boot breaker" +
      " driven from inside the project's own bundle",
    replacement:
      "the daemon, which owns admission, budget, placement and reaping: ADR 0148's cut puts whether, when" +
      " and where a Worker exists in `redskilled`, and only what runs INSIDE the Worker process in" +
      " `@reddb-io/worker`",
    pattern: /\bsupervisor\/[a-z-]+\b|\bcore\/supervisor\b/,
  },
  {
    id: "project-launch-template",
    noun: "dev-worker-body",
    what:
      "the project-side argv composition that told the daemon which `red-skills-dev run --once` command" +
      " line the NEXT Worker should be started with",
    replacement:
      "the daemon composing its own `redskilled acp-worker` launch — a client checkout is never an" +
      " execution input, so the body a Worker runs is not a word the project hands over (ADR 0148)",
    pattern: /\bbuildProjectLaunchTemplate\b|\bProjectLaunchInput\b|\bRED_AFK_(?:WORKER_ID|SLOT)_PLACEHOLDER\b/,
  },
  {
    id: "tmp-janitor",
    noun: "janitor",
    what:
      "the client-checkout janitor — the sweep that ran inside a human's `.red/tmp` beside live worktrees" +
      " it did not own, needed three guards against deleting the wrong thing (#2679, #3650), and still did",
    replacement:
      "the daemon: it deletes only the workspaces it births under `os.tmpdir()/red-skills-<uid>/workers/<id>`" +
      " and prunes the evidence lane `~/.red/tmp/workers/<id>` by a host TTL. Nothing auto-deletes inside a" +
      " client checkout, so there is nothing left for a cleaner to fear (ADR 0149 rule 4)",
    pattern: /[Jj]anitor/,
  },
  {
    id: "client-checkout-reclaim",
    noun: "janitor",
    what:
      "the reclaim modules the janitor planned with — worker, worker-state and branch reclaim, all keyed to" +
      " directories inside a checkout the engine did not own",
    replacement:
      "the daemon's own reclaim over what it births (`apps/redskilled/src/reclaim.ts`), plus the evidence" +
      " lane `~/.red/tmp/workers/<id>` the Worker reclaim rule keeps so a tmpdir sweep never destroys the" +
      " bytes that rescue orphaned work (ADR 0149 rule 2)",
    pattern:
      /\b(?:worker-reclaim|worker-state-reclaim|branch-reclaim|core\/reclaim|runtime\/reclaim)(?:\.js)?\b|\b(?:WorkerReclaim|WorkerStateReclaim|BranchReclaim)[A-Za-z]*\b|\b(?:planWorkerReclaim|planWorkerStateReclaim|planBranchReclaim|reclaimWorkerState|reclaimBranches)\b/,
  },
  {
    id: "castle-resident-resource-kind",
    noun: "resident",
    what:
      "the `castle-resident` resource target the per-project resident registered in the daemon's incident" +
      " store while it was a third process authority beside the daemon and the Worker (ADR 0143)",
    replacement:
      "the `worker` and `daemon` kinds of the `redskilled` incident store, and the daemon's own evidence" +
      " lanes (`~/.red/redskilled/state/deaths/deaths.toonl`, `~/.red/tmp/workers/<id>`) — after ADR 0144" +
      " those are the only two process authorities a host has, so an incident naming a third describes a" +
      " process nothing births",
    pattern: /["']castle-resident["']/,
  },
];

/**
 * The names ADRs 0147–0149 retire. A source entry catches a reader reaching for
 * something removed; a name entry catches the concept returning as VOCABULARY,
 * which is the dimension `red-castle` needs — the package is imported by
 * specifier from 97 modules, and every one of them is a rename site rather than
 * a reader of anything deleted.
 */
export const EXECUTION_CHAIN_NAMES: readonly ExtinctName[] = [
  {
    id: "red-castle-naming",
    noun: "red-castle",
    what:
      "a package specifier, module or identifier named `red-castle` — the substrate that held ~29k lines" +
      " of Worker body with zero ACP while a second Worker body spoke nothing else",
    replacement:
      "`@reddb-io/worker` (`packages/worker`) for everything that runs inside a Worker process, and" +
      " `@reddb-io/protocol-acp` for the shared wire the daemon, the Worker and the Plugin MCPs all speak" +
      " (ADR 0148). The sandcastle lineage moves with the code, in the package's `NOTICE`",
    pattern: /red[^A-Za-z]?castle/i,
  },
  {
    id: "castle-resident-naming",
    noun: "resident",
    what:
      "a module or symbol named for the per-project Castle resident and the belts it owned — the authority" +
      " #3896 retired, together with the private wire its clients dialled",
    replacement:
      "the `redskilled` daemon: it holds project workflow truth, the host's sole GitHub gateway and every" +
      " background belt once per host, and a Plugin MCP is a thin ACP client of it rather than a resident" +
      " of its own (ADR 0144, ADR 0147 rule 2)",
    pattern:
      /castle[^A-Za-z]?resident|resident[^A-Za-z]?(?:authority|cron|read[^A-Za-z]?cache|self[^A-Za-z]?update|unblock|webhook|producer)/i,
  },
];

/**
 * Expand one entry's per-location counts into declared baseline entries, so a
 * crossing states its reason ONCE instead of repeating it per file. PURE.
 *
 * The map is `<repo-relative path> → references today`. A slice that deletes
 * some of them lowers the number; a slice that clears the file removes the line.
 */
function crossing(
  id: string,
  reason: string,
  counts: Readonly<Record<string, number>>,
): ExtinctSourceBaselineEntry[] {
  return Object.entries(counts).map(([path, count]) => ({ id: `${id}:${path}`, count, reason }));
}


/**
 * The execution-chain crossing's declared locations, at TODAY'S COUNTS.
 *
 * Nothing here has been deleted yet, which is the point: the inventory lands
 * before the demolition so that every later slice is measured against a number
 * somebody wrote down. A slice that removes references LOWERS the count; a slice
 * that clears a file REMOVES the line; a slice that needs the number RAISED is
 * putting back the surface an ADR retired, and the ratchet says so by name.
 *
 * Grouped by entry, with the reason stated once per group — a per-file reason
 * repeated 97 times is 97 places for one fact to go stale.
 */
export const EXECUTION_CHAIN_BASELINE: readonly ExtinctSourceBaselineEntry[] = [
  ...crossing(
    "dev-cli-binary",
    "the binary still ships and is still named by guards, docs helpers and the container entrypoint; the slice that deletes the bundle clears the line",
    {
      "apps/afk-container/src/entrypoint.mjs": 1,
      "apps/dev/src/cli.ts": 3,
      "apps/dev/src/commands/install-type-labels.ts": 1,
      "apps/dev/src/commands/worktree.ts": 1,
      "apps/dev/src/core/bare-invocation-guard.ts": 1,
      "apps/dev/src/core/codex-monitor-agent.ts": 1,
      "apps/dev/src/core/engine-floor.ts": 1,
      "apps/dev/src/core/retake.ts": 2,
      "apps/dev/src/mcp-server.ts": 2,
      "apps/dev/src/runtime/published-entry.ts": 2,
      "packages/red-castle/src/extinct-nouns.ts": 1,
      "packages/shared/canonical-invocation.ts": 1,
    },
  ),
  ...crossing(
    "dev-cli-router",
    "the router still routes 36 commands; it clears when the last one a skill names has become an `rs_dev` tool and the rest have died with the bundle",
    {
      "apps/dev/src/cli.ts": 17,
    },
  ),
  ...crossing(
    "dev-worker-run-command",
    "the dev bundle is still a Worker body; the line clears as `@reddb-io/worker` becomes the only one",
    {
      "apps/dev/src/cli.ts": 1,
      "apps/dev/src/commands/run.ts": 14,
      "apps/dev/src/commands/run/activity.ts": 1,
      "apps/dev/src/commands/run/command.ts": 16,
      "apps/dev/src/commands/run/flags.ts": 19,
      "apps/dev/src/commands/run/process-deps.ts": 7,
      "apps/dev/src/commands/run/state.ts": 3,
      "apps/dev/src/core/file-size-guard.ts": 2,
    },
  ),
  ...crossing(
    "dev-bundle-supervisor",
    "the project still drives slots, reaping and heartbeats from its own bundle; the line clears as the daemon takes the control half",
    {
      "apps/dev/src/commands/monitor.ts": 1,
      "apps/dev/src/commands/run/command.ts": 1,
      "apps/dev/src/core/host-owns-birth-guard.ts": 4,
      "apps/dev/src/core/supervisor.ts": 11,
      "apps/dev/src/runtime/redskilled-worker-log.ts": 1,
      "apps/dev/src/runtime/registration-launch.ts": 1,
      "apps/dev/src/runtime/supervisor-fs.ts": 1,
      "apps/dev/src/runtime/wire/boot.ts": 1,
      "apps/dev/src/runtime/wire/statusline.ts": 1,
    },
  ),
  ...crossing(
    "project-launch-template",
    "the project still hands the daemon the argv of the next Worker; it clears when the daemon composes `redskilled acp-worker` itself",
    {
      "apps/dev/src/core/supervisor/launch-template.ts": 8,
      "apps/dev/src/runtime/redskilled-worker-log.ts": 5,
      "apps/dev/src/runtime/registration-launch.ts": 2,
    },
  ),
  ...crossing(
    "tmp-janitor",
    "the janitor still sweeps a human's checkout; it clears when Worker workspaces move to OS temporary storage and the module is deleted",
    {
      "apps/dev/src/commands/boot-sweeps.ts": 5,
      "apps/dev/src/commands/red-doctor.ts": 15,
      "apps/dev/src/commands/run/state.ts": 1,
      "apps/dev/src/core/boot.ts": 18,
      "apps/dev/src/core/tmp-janitor.ts": 42,
      "apps/dev/src/core/worker-reclaim.ts": 1,
      "apps/dev/src/core/worktree-lane-doctor.ts": 1,
      "apps/dev/src/runtime/deadend-audit-report.ts": 3,
      "apps/dev/src/runtime/tmp-janitor.ts": 37,
      "apps/dev/src/runtime/wire/boot.ts": 10,
      "apps/dev/src/runtime/wire/monitor.ts": 1,
    },
  ),
  ...crossing(
    "client-checkout-reclaim",
    "reclaim is still planned against directories inside a client checkout; it clears with the janitor that called it",
    {
      "apps/dev/src/commands/reap.ts": 3,
      "apps/dev/src/core/boot.ts": 9,
      "apps/dev/src/core/branch-reclaim.ts": 23,
      "apps/dev/src/core/reclaim.ts": 1,
      "apps/dev/src/core/tmp-janitor.ts": 1,
      "apps/dev/src/core/worker-reclaim.ts": 16,
      "apps/dev/src/core/worker-state-reclaim.ts": 1,
      "apps/dev/src/runtime/gh/sweeps.ts": 1,
      "apps/dev/src/runtime/tmp-janitor.ts": 7,
      "apps/dev/src/runtime/wire/boot.ts": 1,
      "apps/dev/src/runtime/wire/monitor.ts": 2,
      "apps/dev/src/runtime/worker-state-reclaim.ts": 1,
      "apps/dev/src/runtime/worker-workspace-retention.ts": 2,
    },
  ),
  ...crossing(
    "castle-resident-resource-kind",
    "the daemon's incident store still accepts a third process authority; it clears when the kind union is `worker | daemon`",
    {
      "apps/redskilled/src/resource-incidents.ts": 1,
    },
  ),
  ...crossing(
    "red-castle-naming",
    "one rename site onto `@reddb-io/worker` / `@reddb-io/protocol-acp`; a migration slice lowers the number as it moves the code it names",
    {
      "apps/dev/src/acp-lane-follower.ts": 1,
      "apps/dev/src/commands/audit-skills.ts": 1,
      "apps/dev/src/commands/go.ts": 1,
      "apps/dev/src/commands/monitor.ts": 1,
      "apps/dev/src/commands/red-doctor.ts": 3,
      "apps/dev/src/commands/requeue.ts": 1,
      "apps/dev/src/commands/respond.ts": 1,
      "apps/dev/src/commands/review.ts": 1,
      "apps/dev/src/commands/run/claim-lease.ts": 1,
      "apps/dev/src/commands/run/command.ts": 1,
      "apps/dev/src/commands/run/flags.ts": 1,
      "apps/dev/src/commands/run/implementer-run-agent.ts": 1,
      "apps/dev/src/commands/run/process-deps.ts": 2,
      "apps/dev/src/commands/run/reconcile.ts": 1,
      "apps/dev/src/commands/run/state.ts": 2,
      "apps/dev/src/core/adversarial-review.ts": 1,
      "apps/dev/src/core/boot.ts": 1,
      "apps/dev/src/core/castle-cutover-migration.ts": 1,
      "apps/dev/src/core/castle-state-doctor.ts": 3,
      "apps/dev/src/core/castle-worker-lane-bridge.ts": 2,
      "apps/dev/src/core/claim-staleness.ts": 2,
      "apps/dev/src/core/claim.ts": 2,
      "apps/dev/src/core/comment-respond-extract.ts": 1,
      "apps/dev/src/core/declared-wait-guard.ts": 5,
      "apps/dev/src/core/envelope.ts": 2,
      "apps/dev/src/core/execution.ts": 2,
      "apps/dev/src/core/execution/host-hooks.ts": 1,
      "apps/dev/src/core/execution/runtime.ts": 7,
      "apps/dev/src/core/file-size-guard.ts": 9,
      "apps/dev/src/core/handoff.ts": 4,
      "apps/dev/src/core/history.ts": 1,
      "apps/dev/src/core/hitl-card.ts": 2,
      "apps/dev/src/core/host-env-allowlist.ts": 1,
      "apps/dev/src/core/land-lock.ts": 1,
      "apps/dev/src/core/lane-idle-reaper.ts": 1,
      "apps/dev/src/core/lane-retention-guard.ts": 4,
      "apps/dev/src/core/monitor.ts": 1,
      "apps/dev/src/core/pr-medic.ts": 1,
      "apps/dev/src/core/process-issue/lifecycle.ts": 1,
      "apps/dev/src/core/process-issue/reseed-handoff.ts": 1,
      "apps/dev/src/core/process-issue/spin-lifecycle.ts": 1,
      "apps/dev/src/core/process-issue/terminal.ts": 1,
      "apps/dev/src/core/process-issue/types.ts": 1,
      "apps/dev/src/core/repair-guard.ts": 4,
      "apps/dev/src/core/repo-invariants.ts": 5,
      "apps/dev/src/core/review-extract.ts": 1,
      "apps/dev/src/core/runner-detection.ts": 2,
      "apps/dev/src/core/runner-spawn.ts": 3,
      "apps/dev/src/core/runner-spec.ts": 2,
      "apps/dev/src/core/session.ts": 1,
      "apps/dev/src/core/skill-audit-extract.ts": 1,
      "apps/dev/src/core/state-transition.ts": 2,
      "apps/dev/src/core/supervisor/boot-breaker.ts": 1,
      "apps/dev/src/core/supervisor/config.ts": 1,
      "apps/dev/src/core/supervisor/envelopes.ts": 1,
      "apps/dev/src/core/supervisor/types.ts": 3,
      "apps/dev/src/core/verdict.ts": 1,
      "apps/dev/src/core/worker-outcome.ts": 1,
      "apps/dev/src/core/worker-paths.ts": 1,
      "apps/dev/src/core/worker-state-reader.ts": 1,
      "apps/dev/src/lane-subscription.ts": 1,
      "apps/dev/src/mcp-server.ts": 1,
      "apps/dev/src/runtime/implementer-environment.ts": 1,
      "apps/dev/src/runtime/merge-driver-io.ts": 1,
      "apps/dev/src/runtime/red-path-migration.ts": 1,
      "apps/dev/src/runtime/supervisor-fs.ts": 2,
      "apps/dev/src/runtime/wire/boot.ts": 1,
      "apps/dev/src/runtime/wire/monitor.ts": 1,
      "apps/dev/src/runtime/wire/paths.ts": 1,
      "apps/dev/src/runtime/wire/settings.ts": 1,
      "apps/dev/src/runtime/wire/statusline.ts": 1,
      "apps/dev/src/runtime/worker-state-reclaim.ts": 1,
      "apps/dev/src/types/runner.ts": 2,
      "apps/herdr-plugin-red-skills/scripts/fake-daemon.mjs": 1,
      "apps/herdr-plugin-red-skills/scripts/preview.mjs": 1,
      "apps/redskilled/src/acp-child-agent.ts": 1,
      "apps/redskilled/src/acp-child-spin.ts": 1,
      "apps/rsp/src/wait/webhook-wake-source.ts": 1,
      "packages/red-castle/.factory/implement-task.ts": 2,
      "packages/red-castle/.red-castle/run.ts": 4,
      "packages/red-castle/src/EnvResolver.ts": 1,
      "packages/red-castle/src/InitService.ts": 18,
      "packages/red-castle/src/PromptResolver.ts": 1,
      "packages/red-castle/src/RecoveryMessage.ts": 2,
      "packages/red-castle/src/WorktreeManager.ts": 3,
      "packages/red-castle/src/cli.ts": 3,
      "packages/red-castle/src/createSandbox.ts": 1,
      "packages/red-castle/src/createWorktree.ts": 3,
      "packages/red-castle/src/engine/tracker/github/adapter.ts": 8,
      "packages/red-castle/src/mountUtils.ts": 1,
      "packages/red-castle/src/run.ts": 1,
      "packages/red-castle/src/syncOut.ts": 3,
      "packages/red-castle/src/templates/blank/main.mts": 2,
      "packages/red-castle/src/templates/parallel-planner-with-review/main.mts": 5,
      "packages/red-castle/src/templates/parallel-planner/main.mts": 4,
      "packages/red-castle/src/templates/sequential-reviewer/main.mts": 3,
      "packages/red-castle/src/templates/simple-loop/main.mts": 2,
    },
  ),
  ...crossing(
    "castle-resident-naming",
    "the retired resident's status schema still ships in the package's MCP contracts; it clears when those schemas move to `rs_dev`",
    {
      "apps/redskilled/src/resource-incidents.ts": 1,
      "packages/red-castle/src/mcp/contracts.ts": 4,
    },
  ),
];
