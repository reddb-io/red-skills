// extinct-execution-chain — the second crossing on the extinction ratchet: the
// surfaces ADRs 0147, 0148 and 0149 retire (Spec #4007, issue #4009).
//
// The first crossing (ADR 0130) ran to zero, which is why
// `EXTINCT_SOURCE_BASELINE` stood empty. This one started at TODAY'S COUNT and
// is being paid down slice by slice. Two lines have cleared:
//
//   - the `red-castle` package specifier — issue #4013 moved
//     `packages/red-castle` to `packages/worker` as `@reddb-io/worker`, so the 78
//     importer rename sites are gone and what remains under that entry is the
//     vendored source's own on-disk `.red-castle` config directory and cache-key
//     vocabulary, which are behaviour rather than naming;
//   - the DEV CLI AND ITS WORKER BODY — issue #4031 deleted the 36-command
//     router, every command it reached, the `run` body, the supervisor state
//     machine and the project-side launch template, so `dev-cli-router`,
//     `dev-worker-run-command`, `dev-bundle-supervisor` and
//     `project-launch-template` all stand at zero. `dev-cli-binary` keeps two
//     references and neither is a reader: one is the ratchet that REFUSES the
//     name in a doc, and one is the container lane whose Worker body moves in
//     its own slice.
//
// What is still owed is the janitor, the client-checkout reclaim it planned
// with, and the vendored `red-castle` vocabulary.
//
// Declaring the inventory BEFORE the deletion is what makes the deletion a
// ratchet rather than a hope — a slice may lower a count, and a slice that
// raises one is reintroducing the surface the ADR retired.
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
 * which is the dimension `red-castle` needs — the package was imported by
 * specifier from 97 modules, every one of them a rename site rather than a
 * reader of anything deleted. Issue #4013 paid those sites: the specifier is now
 * `@reddb-io/worker`, and the entry keeps watch so the old noun cannot return.
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
 * The inventory landed BEFORE the demolition, which is the point: every slice is
 * measured against a number somebody wrote down. A slice that removes references
 * LOWERS the count; a slice that clears a file REMOVES the line; an entry with no
 * locations left is an entry that has been PAID, and its absence here is what
 * makes every future reference a failure rather than a tolerance. A slice that
 * needs a number RAISED is putting back the surface an ADR retired, and the
 * ratchet says so by name.
 *
 * Grouped by entry, with the reason stated once per group — a per-file reason
 * repeated 97 times is 97 places for one fact to go stale.
 */
export const EXECUTION_CHAIN_BASELINE: readonly ExtinctSourceBaselineEntry[] = [
  ...crossing(
    "dev-cli-binary",
    "the binary is deleted; what still spells its name is the ratchet that REFUSES it in a doc, plus the container lane that has not moved its Worker body yet",
    {
      // The container drives `red-skills-dev run --issues N --runner R --once`
      // end to end. ADR 0148 gives that body to `@reddb-io/worker` under the
      // daemon, and ADR 0153 renames the app to `worker-container`; both are
      // that lane's own slice, and until it lands the entrypoint names what it
      // actually calls rather than a binary it does not.
      "apps/afk-container/src/entrypoint.mjs": 1,
      // A refusal has to spell the noun it refuses: `EXECUTION_CHAIN_ENTRYPOINTS`
      // declares `red-skills-dev` NOT instructable, which is how a doc that puts
      // a subcommand after it fails. Deleting the literal would delete the
      // refusal.
      "apps/dev/src/core/bare-invocation-guard.ts": 1,
    },
  ),
  ...crossing(
    "tmp-janitor",
    "the janitor still sweeps a human's checkout; it clears when Worker workspaces move to OS temporary storage and the module is deleted",
    {
      "apps/dev/src/core/worktree-lane-doctor.ts": 1,
      "apps/dev/src/runtime/wire/boot.ts": 2,
    },
  ),
  ...crossing(
    "client-checkout-reclaim",
    "reclaim is still planned against directories inside a client checkout; it clears with the janitor that called it",
    {
      "apps/dev/src/core/boot.ts": 5,
      "apps/dev/src/core/branch-reclaim.ts": 23,
      "apps/dev/src/runtime/gh/sweeps.ts": 1,
      "apps/dev/src/runtime/wire/boot.ts": 1,
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
      "apps/dev/src/core/castle-cutover-migration.ts": 1,
      "apps/dev/src/core/castle-state-doctor.ts": 2,
      "apps/dev/src/core/handoff.ts": 3,
      "apps/dev/src/core/worker-paths.ts": 1,
      "apps/dev/src/runtime/supervisor-fs.ts": 1,
      "packages/worker/.factory/implement-task.ts": 2,
      "packages/worker/.red-castle/run.ts": 4,
      "packages/worker/src/EnvResolver.ts": 1,
      "packages/worker/src/InitService.ts": 18,
      "packages/worker/src/PromptResolver.ts": 1,
      "packages/worker/src/RecoveryMessage.ts": 2,
      "packages/worker/src/WorktreeManager.ts": 3,
      "packages/worker/src/createSandbox.ts": 1,
      "packages/worker/src/createWorktree.ts": 3,
      "packages/worker/src/engine/tracker/github/adapter.ts": 8,
      "packages/worker/src/mountUtils.ts": 1,
      "packages/worker/src/run.ts": 1,
      "packages/worker/src/syncOut.ts": 3,
      "packages/worker/src/templates/blank/main.mts": 2,
      "packages/worker/src/templates/parallel-planner-with-review/main.mts": 5,
      "packages/worker/src/templates/parallel-planner/main.mts": 4,
      "packages/worker/src/templates/sequential-reviewer/main.mts": 3,
      "packages/worker/src/templates/simple-loop/main.mts": 2,
    },
  ),
  ...crossing(
    "castle-resident-naming",
    "the daemon's incident store still accepts the retired authority as a resource kind; the `rs_dev` contracts that carried its status schema cleared with issue #4023",
    {
      "apps/redskilled/src/resource-incidents.ts": 1,
    },
  ),
];