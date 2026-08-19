// repo-invariants — repo-wide invariant suites that every gate run must include,
// no matter how narrow the cone (issue #2762).
//
// A cone-scoped gate runs the test/typecheck/lint/build of the changed packages
// and their dependents. That is correct for package-local behavior and WRONG for
// a repo-wide invariant: the TOON JSON file-I/O ratchet lives in `apps/dev` but
// constrains every file under `apps/` and `packages/`. A worker that edits only
// `apps/rsp` validates green, reports DONE, and the ratchet first fires in root
// CI — after the correction budget is spent. The invariant was enforced outside
// the only loop that could still satisfy it.
//
// The fix is a small, declared list: suites that run in EVERY gate run whose cone
// does not already cover them. Adding an invariant is a one-entry change here
// plus the package script it names.

/** One repo-wide invariant suite: a package script that constrains the whole repo. */
export interface RepoInvariantSuite {
  /** Canonical check name, surfaced in the sidecar record (`invariants:<slug>`). */
  name: string;
  /** Repo-relative dir of the package that owns the suite (never `"."`). */
  scope: string;
  /** The package script that runs ONLY the invariant suites (not the full suite). */
  script: string;
  /** One line on what the suite enforces — read by a human triaging a park. */
  why: string;
}

/**
 * The declared repo-wide invariant suites. Keep this list SHORT and CHEAP: every
 * entry runs on every cone-scoped gate run, so a slow suite taxes every landing.
 * A suite belongs here only when it enforces a constraint that spans packages.
 */
export const REPO_INVARIANT_SUITES: readonly RepoInvariantSuite[] = [
  {
    name: "invariants:file-size",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the file-size ratchet constrains every source file under apps/ and packages/, so a god file growing back in any package must redden the cone-scoped gate that touched it",
  },
  {
    name: "invariants:toon-json-io",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the TOON JSON I/O ratchet constrains every file AND every wire under apps/ and packages/, but its suite lives in apps/dev",
  },
  {
    name: "invariants:extinct-nouns",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the Fleet/Attempt extinction ratchet (ADR 0130) constrains every reader under apps/ and packages/, but its suite lives in apps/dev",
  },
  {
    name: "invariants:custody-verdict-park",
    scope: "apps/dev",
    script: "test:invariants",
    why: "ADR 0136 permits one custody re-queuer, blocker parser, and requeue applier across apps/ and packages/, and forbids the deleted classification hook",
  },
  {
    name: "invariants:host-owns-birth",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the daemon is the only launcher (ADR 0130, #2851): a per-project module that can create a process births a Worker no host admission verdict judged",
  },
  {
    name: "invariants:shipped-primitives",
    scope: "apps/dev",
    script: "test:invariants",
    why: "a declared safety primitive must have a non-test enabler anywhere under apps/ or packages/ (#2800), but its suite lives in apps/dev",
  },
  {
    name: "invariants:shipped-binaries",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every binary in every workspace bin map must answer --version off the build stamp and route argv through the shared contract (#2878); the bin maps span apps/ and packaging/, the suite lives in apps/dev",
  },
  {
    name: "invariants:declared-waits",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every wait loop in the engine must declare its subject, deadline and escalation (#3024); the loops span apps/dev and packages/worker, the suite lives in apps/dev",
  },
  {
    name: "invariants:skill-named-verbs",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every verb a shipped skill still names must have an `rs_dev` tool of the same core, and every command no skill names must be recorded for deletion (ADR 0147 rule 1, #4024); the skill tree lives in plugins/, the tool surface in apps/dev",
  },
  {
    name: "invariants:bare-invocations",
    scope: "apps/dev",
    script: "test:invariants",
    why: "no doc surface may offer a bare shipped-binary command (#3071); the swept surfaces span README.md, docs/, plugins/, apps/ and packaging/, the suite lives in apps/dev",
  },
  {
    name: "invariants:statusline-command",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the documented statusLine command must be one string and must exit 0 (#3073); its copies live in plugins/ and packaging/, the suite lives in apps/dev",
  },
  {
    name: "invariants:lane-run-mode",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every lane the castle drain isolates must declare the run mode it implies (#3026); the lane set lives in packages/worker, the claim that enforces it in apps/dev",
  },
  {
    name: "invariants:asked-balance",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the GitHub balance must be asked, never accumulated (#3095, ADR 0132 Amendment 2); the swept code spans packages/github, apps/redskilled and apps/dev, the suite lives in apps/dev",
  },
  {
    name: "invariants:github-read-routing",
    scope: "apps/dev",
    script: "test:invariants",
    why: "raw GitHub reads must shrink toward @reddb-io/github across apps/dev, apps/redskilled and packages/worker (#3451); the inventory suite lives in apps/dev",
  },
  {
    name: "invariants:toon-catalog-pin",
    scope: "apps/dev",
    script: "test:invariants",
    why: "the pnpm catalog is the one toon/tq version (ADR 0097, #3072); the derived sites span pnpm-workspace.yaml, .github/workflows/, plugins/ and every packages/*/package.json, the suite lives in apps/dev",
  },
  {
    name: "invariants:version-train",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every workspace under apps/, packages/ and plugins/ must carry one product version and ride a release train that carries it forward (#3082); the packages span the repo, the suite lives in apps/dev",
  },
  {
    name: "invariants:structured-repairs",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every structured castle refusal must carry a callable repair or an argued none (#3260); the refusal surfaces span apps/dev and packages/worker, the suite lives in apps/dev",
  },
  {
    name: "invariants:truecolor-extinction",
    scope: "apps/dev",
    script: "test:invariants",
    why: "ADR 0137 forbids literal truecolor escapes across the dev statusline, VS Code dashboard, herdr panes, and the shared redskilled render; the painted surfaces span three apps and one package, but their ratchet lives in apps/dev",
  },
  {
    name: "invariants:lane-retention",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every registered TOONL lane must be enforced by a writer and observable by the census (#3645); the lanes span apps/dev, apps/redskilled, apps/rsp, packages/github, packages/worker and packages/shared, the suite lives in apps/dev",
  },
  {
    name: "invariants:working-mode",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every shipped SKILL.md must declare exactly one of ADR 0150's four Working modes (#4012); the skills span every plugin, but their ratchet lives in apps/dev",
  },
  {
    name: "invariants:codex-skill-sidecars",
    scope: "apps/dev",
    script: "test:invariants",
    why: "every SKILL.md in the plugin tree must carry the generated Codex discovery policy beside it (#3431); the skills span every plugin, but their ratchet lives in apps/dev",
  },
];

/** One execution of a package script, carrying every invariant it enforces. */
export interface RepoInvariantRun {
  scope: string;
  script: string;
  /** The declared suites this one execution covers, in declaration order. */
  suites: readonly RepoInvariantSuite[];
}

/**
 * True when `scopes` already runs `suite` as part of the ordinary scoped loop —
 * either the whole-workspace scope (`"."`, which runs the workspace-wide turbo
 * commands) or the suite's own package is in the cone (its `test` script covers
 * the invariant suite too). PURE.
 */
export function scopesCoverInvariantSuite(
  scopes: readonly string[],
  suite: RepoInvariantSuite,
): boolean {
  return scopes.includes(".") || scopes.includes(suite.scope);
}

/**
 * The invariant suites a cone-scoped run must add on top of its scoped checks —
 * every declared suite the cone does not already cover. PURE.
 *
 * An empty `scopes` (a repo with no package.json anywhere) yields no suites: a
 * no-package repo has no script to run.
 */
export function pendingInvariantSuites(
  scopes: readonly string[],
  suites: readonly RepoInvariantSuite[] = REPO_INVARIANT_SUITES,
): RepoInvariantSuite[] {
  if (scopes.length === 0) return [];
  return suites.filter((suite) => !scopesCoverInvariantSuite(scopes, suite));
}

/**
 * The pending suites grouped into the DISTINCT script executions they need —
 * several invariants may share one suite script, and running it once per declared
 * invariant would tax every cone-scoped landing for nothing. Each run still
 * reports every invariant it carries, so a park names the constraint that failed
 * rather than only the script. PURE.
 */
export function pendingInvariantRuns(
  scopes: readonly string[],
  suites: readonly RepoInvariantSuite[] = REPO_INVARIANT_SUITES,
): RepoInvariantRun[] {
  const runs: RepoInvariantRun[] = [];
  const byKey = new Map<string, RepoInvariantSuite[]>();
  for (const suite of pendingInvariantSuites(scopes, suites)) {
    const key = `${suite.scope} ${suite.script}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.push(suite);
      continue;
    }
    const group = [suite];
    byKey.set(key, group);
    runs.push({ scope: suite.scope, script: suite.script, suites: group });
  }
  return runs;
}
