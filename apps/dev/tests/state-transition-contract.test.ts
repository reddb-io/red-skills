// state-transition-contract.test.ts — the transition-API contract lint (#2528,
// #2664, ADR 0122 rule 5).
//
// Engine code must not hand-roll issue STATE-ROLE label edits: every mutation
// that queues, parks, promotes, quarantines, or dependency-blocks an issue
// flows through `planTransition`/`applyTransition` so the one-state-role
// invariant is proven at plan time. This test scans the engine source for RAW
// label-writer call sites whose arguments mention a state-role label and fails
// on any site that is not in the explicit allowlist below.
//
// A raw writer is any of: `editLabels(`, the legacy `editLabelsTagged(`
// wrapper, a `gh issue edit --add-label/--remove-label` command line built in
// a .ts source, or a dispose-set literal (`addLabels: [...]`) that names a
// state role. Planner-backed wrappers (PLANNER_BACKED_WRAPPERS) are the
// transition API itself, not a bypass of it — a guard test below pins that
// each one still routes through the planner.
//
// Adding a NEW raw state-label edit fails this test by design — route it
// through the transition API, or (for a genuinely justified survivor: a
// documented legacy fallback, a non-issue surface like PR review labels, or a
// human/manual command surface) add it to the allowlist WITH a reason.
//
// This lint owns the HOST tree only. The planner itself lives in the Worker
// package's `engine/state-transition.ts` since #2666, and that tree is scanned by
// its own suite (`src/engine/state-transition-contract.test.ts`) with an
// EMPTY allowlist — never re-add those paths here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Scanned trees. The castle engine joined the scan in #2664: the planner's
 * state writers migrate there in Wave C, and an unscanned destination is how a
 * migration quietly loses its contract. */
const SCAN_ROOTS: readonly { readonly label: string; readonly dir: string }[] = [
  { label: "apps/dev/src", dir: join(HERE, "..", "src") },
  { label: "worker/engine", dir: join(HERE, "..", "..", "..", "packages", "worker", "src", "engine") },
];

/** The transition API's own sources: they DEFINE the state vocabulary and the
 * planned mutation, so their literals are the contract, not a bypass of it. */
const CONTRACT_SOURCES = new Set([
  "apps/dev/src/core/triage-labels.ts",
  "apps/dev/src/core/state-transition.ts",
]);

/**
 * Files exempt WHOLESALE, with an expiry condition. Empty since Wave C
 * (#2666): the planner now lives in castle, and both castle modules that held
 * a temporary exemption — `engine/issue-state-curator.ts` and
 * `engine/tracker/dependencies.ts` — route their writes through
 * `planTransition`. An entry here must always name the condition that ends it;
 * the expiry test below fails an entry whose file no longer has a raw writer.
 */
const FILE_ALLOWLIST = new Map<string, string>([]);

/** Wrappers that are the transition API rather than a way around it. Their
 * call sites are not raw edits — `planner-backed wrappers still route through
 * the planner` pins that claim so the exemption cannot rot silently. */
const PLANNER_BACKED_WRAPPERS = ["editIssueLifecycleLabels", "applyLifecycleLabelEdit", "transitionLabels", "applyTransition"] as const;

/** Raw label-writer shapes. `editLabelsTagged` is the pre-#2663 wrapper: it
 * wrote (remove, add) pairs with no plan, so a re-introduction is a
 * regression, not a survivor. */
const RAW_WRITER_PATTERN =
  /\beditLabels\(|\beditIssueLabels\(|\beditLabelsTagged\(|--(?:add|remove)-label|\baddLabels:\s*\[/;

/** Interface members and implementations of a writer, not call sites of one.
 *
 * The `function` form closes the #2894 hole: the port's OWN implementation
 * (`export async function editLabels(ctx: GhContext, …)`) leads with a context
 * parameter, so the member form missed it, and the statement collapser then
 * swallowed the first lines of the body — making the lane-isolation guard
 * inside the port read as a raw state write by its own port. */
const WRITER_DECLARATION_PATTERN =
  /\bedit(?:Issue)?Labels(?:Tagged)?\??\(\s*(?:issue|pr|candidate|number|n)\s*:|\bfunction\s+edit(?:Issue)?Labels(?:Tagged)?\(/;

/** State-role vocabulary (constants, literals, and injected-config accessors)
 * that marks an edit as a STATE mutation. `running`/`contested`/typed
 * `blocked:*` reasons alone are projections or modifiers, not state roles.
 *
 * `LABEL_READY(_FOR_AGENT)?` closes the #2664 word-boundary hole: the old
 * `LABEL_READY\b` matched the short spelling only, so a portified constant
 * named `LABEL_READY_FOR_AGENT` walked straight past the scan — while
 * `LABEL_READY_FOR_REVIEW` (a PR lane label, not a state role) must still NOT
 * match, which is why the suffix is enumerated instead of made open-ended.
 *
 * The `<config>.ready` / `.human` / `.dependency` accessors keep PORTIFIED
 * engine code covered (#2665): a module that reads its label vocabulary from an
 * injected `TriageLabelConfig` instead of value-importing `LABEL_*` would
 * otherwise fall out of this scan entirely and take its call sites with it. */
const STATE_ROLE_LITERALS = "ready-for-agent|ready-for-human|needs-triage|needs-info|quarantine|blocked:dependency";
const STATE_ROLE_PATTERN = new RegExp(
  [
    String.raw`\bLABEL_(?:READY(?:_FOR_AGENT)?|HUMAN|READY_FOR_HUMAN|QUARANTINE|TRIAGE|NEEDS_TRIAGE|NEEDS_INFO|DEPENDENCY|BLOCKED_DEPENDENCY)\b`,
    String.raw`\blabels\.(?:ready|human|quarantine|needsTriage|needsInfo|dependency)\b`,
    // Quoted literal, e.g. `editLabels(n, ["ready-for-agent"], [])`.
    String.raw`["'\`](?:${STATE_ROLE_LITERALS})["'\`]`,
    // Unquoted CLI argument, e.g. `gh issue edit N --add-label ready-for-agent`.
    String.raw`--(?:add|remove)-label[=\s]+(?:${STATE_ROLE_LITERALS})\b`,
    // A local alias of the canonical vocabulary, e.g. castle's `const READY`.
    String.raw`\b(?:READY|HUMAN|QUARANTINE|NEEDS_TRIAGE|NEEDS_INFO|DEPENDENCY_BLOCKED)\b`,
  ].join("|"),
);

/** A local re-declaration of the canonical label vocabulary, e.g. castle's
 * `const READY = "ready-for-agent"`. An alias is not itself a write, but it is
 * how a writer LEAVES this scan: the call site then names `READY`, matches no
 * `LABEL_*` constant, and reads as compliant (#2664). Aliases must import from
 * triage-labels.ts (or, across the package edge, take an injected vocabulary).
 * `??` defaults and type-union members are reads, not vocabulary — excluded. */
const VOCABULARY_ALIAS_PATTERN = new RegExp(
  String.raw`\b(?:const|let|var)\s+\w+\s*(?::\s*string\s*)?=\s*["'\`](?:${STATE_ROLE_LITERALS})["'\`]`,
);

/**
 * Surviving raw call sites, keyed `root/relative-path :: normalized-statement`.
 * Every entry must carry a reason. Shrinking this list is progress; growing it
 * needs the same justification bar as a new ADR 0122 exception.
 */
const ALLOWLIST = new Map<string, string>([
  // --- documented legacy fallbacks (labels unavailable at the call site) ---
  //
  // #2663 emptied three former groups from this list: the reconcile lane's
  // typed parks + cascade mirror, the supervisor reaper / death-sweep dispose
  // sets, and the companion drift correction all plan their delta now. What
  // survives below is either a cascade fallback whose candidate labels were
  // never listed, or claim / PR / maintainer-command vocabulary that is not an
  // issue STATE transition at all.
  [
    'apps/dev/src/core/boot-sweep.ts :: await gh.editLabels( p.number, [remove, ...p.reqLabels], [p.lane === "human" ? LABEL_HUMAN : LABEL_READY], );',
    "unblock-sweep fallback when the candidate's labels were not listed (#2528); the lane still follows the planned HUMAN-ONLY routing (#2966)",
  ],
  [
    'apps/dev/src/core/process-issue/terminal.ts :: await deps.gh.editLabels( p.number, [LABEL_DEPENDENCY, ...p.reqLabels], [p.lane === "human" ? LABEL_HUMAN : LABEL_READY], );',
    "close-cascade fallback when the dependent's labels were not listed (#2528); the lane still follows the planned HUMAN-ONLY routing (#2966)",
  ],
  // --- claim machinery: ready<->running swaps are claims, not state transitions ---
  [
    "apps/dev/src/core/supervisor/reaper.ts :: await deps.gh.editLabels(contest.issue, [LABEL_READY], [LABEL_RUNNING, LABEL_CONTESTED]);",
    "reap-contest claim swap; claim vocabulary, not a state transition",
  ],
  [
    "apps/dev/src/core/supervisor/reaper.ts :: await deps.gh.editLabels( pair.issue, [LABEL_READY, LABEL_RUNNER_ERROR], [LABEL_HUMAN, LABEL_RUNNING], );",
    "half-open probe re-claim of a runner-error park; claim machinery",
  ],
  // --- non-issue surfaces: PR review-lane labels, not issue state ---
  [
    "apps/dev/src/core/review.ts :: await gh.editLabels(pr, [LABEL_RUNNING], [LABEL_HUMAN]);",
    "PR review-lane labels, not issue state",
  ],
  [
    "apps/dev/src/core/review.ts :: await gh.editLabels(pr, [LABEL_RUNNING], [LABEL_VALIDATION, LABEL_HUMAN]);",
    "PR review-lane labels, not issue state",
  ],
  // --- human/manual command surfaces (outside the engine contract by design) ---
  [
    "apps/dev/src/commands/requeue.ts :: await gh.editLabels(input.issue, [LABEL_READY], []);",
    "/requeue is a maintainer command surface (#2509 tracks its own fix)",
  ],
  [
    "apps/dev/src/commands/requeue.ts :: if (readyWithheld) await gh.editLabels(input.issue, [], [LABEL_READY]);",
    "/requeue is a maintainer command surface (#2509 tracks its own fix)",
  ],
  [
    "apps/dev/src/commands/stop.ts :: await ghx.editLabels(ghCtx, issue, [LABEL_RUNNING], [LABEL_READY]);",
    "fleet-stop operator reconcile; runs under explicit human intent",
  ],
  [
    'apps/dev/src/commands/hitl-card.ts :: "gh", "issue", "edit", String(issue.number), ...repoArgs(repo), "--remove-label", LABEL_HUMAN, ]));',
    "HITL reject sheds the human gate with NO automated next state — the one shape a one-state-role plan cannot express (#2663)",
  ],
  // --- policy dispose sets applied through a planner-backed wrapper ---
  [
    "apps/dev/src/core/disposition.ts :: addLabels: [LABEL_READY], typedLabel, envelopeStatus, escalationComment: null, cap, }; }",
    "pure recovery-policy set; its only consumer applies it via editIssueLifecycleLabels → planTransition (#2663)",
  ],
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.endsWith(".test.ts")) yield path;
  }
}

/** Collapse a multi-line call statement to one normalized single-space line. */
function statementAt(lines: string[], index: number): string {
  let statement = lines[index]!;
  let cursor = index;
  while (!statement.includes(");") && cursor + 1 < lines.length && cursor - index < 6) {
    cursor += 1;
    statement += ` ${lines[cursor]!}`;
  }
  return statement.replace(/\s+/g, " ").trim();
}

/** The lines a dispose-set literal sits inside — a `addLabels: [...]` line is
 * a fragment, so its enclosing call has to be read BACKWARD to tell a plan
 * declaration from a write. */
function contextAt(lines: string[], index: number): string {
  return lines.slice(Math.max(0, index - 6), index + 1).join(" ").replace(/\s+/g, " ");
}

/** Scan ONE source file. Exported shape: `${rootLabel}/${rel} :: statement`. */
export function scanSource(path: string, text: string): string[] {
  if (CONTRACT_SOURCES.has(path) || FILE_ALLOWLIST.has(path)) return [];
  return collectWriters(path, text);
}

/** The scan proper, with no file-level exemption applied. */
function collectWriters(path: string, text: string): string[] {
  const lines = text.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // Prose describing a writer is not a writer.
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    if (VOCABULARY_ALIAS_PATTERN.test(line)) {
      found.push(`${path} :: ${line.replace(/\s+/g, " ").trim()}`);
      continue;
    }
    if (!RAW_WRITER_PATTERN.test(line)) continue;
    // Declarations / interface members are not call sites.
    if (WRITER_DECLARATION_PATTERN.test(line)) continue;
    // Planner-backed wrappers ARE the transition API.
    if (PLANNER_BACKED_WRAPPERS.some((fn) => line.includes(`${fn}(`))) continue;
    const statement = statementAt(lines, i);
    if (!STATE_ROLE_PATTERN.test(statement)) continue;
    if (/\baddLabels:\s*\[/.test(line)) {
      // A dispose set fed to the planner (or validated against it) is a plan,
      // not a write; only free-standing dispose literals are raw writers.
      const context = contextAt(lines, i);
      if (/planTransition\(|transitionLabels\(/.test(context)) continue;
    }
    found.push(`${path} :: ${statement}`);
  }
  return found;
}

describe("transition-API contract lint (#2528, #2664)", () => {
  it("flags a raw editLabels site, a wrapper site, and a gh-CLI site", () => {
    const rawEdit = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ['await deps.gh.editLabels(issue, [LABEL_READY], [LABEL_HUMAN]);'].join("\n"),
    );
    expect(rawEdit).toEqual([
      "apps/dev/src/core/synthetic.ts :: await deps.gh.editLabels(issue, [LABEL_READY], [LABEL_HUMAN]);",
    ]);

    const wrapper = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ['await editLabelsTagged(deps, issue, [LABEL_RUNNING], [LABEL_READY], "retry");'].join("\n"),
    );
    expect(wrapper).toHaveLength(1);

    const ghCli = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ['await sh(`gh issue edit ${n} --remove-label running --add-label ready-for-agent`);'].join("\n"),
    );
    expect(ghCli).toHaveLength(1);

    // The castle-side writer shape (`tracker.editIssueLabels(n, {remove, add})`).
    const castleWriter = scanSource(
      "worker/engine/synthetic.ts",
      ["await input.tracker.editIssueLabels(issue.number, {", '  remove: ["quarantine"],', '  add: ["ready-for-agent"],', "});"].join("\n"),
    );
    expect(castleWriter).toHaveLength(1);

    const disposeSet = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ["const disp = {", "  removeLabels: [LABEL_RUNNING],", "  addLabels: [LABEL_READY],", "};"].join("\n"),
    );
    expect(disposeSet).toHaveLength(1);
  });

  it("flags a local alias of the canonical vocabulary but not a read default", () => {
    const alias = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ['const READY = "ready-for-agent";'].join("\n"),
    );
    expect(alias).toEqual(['apps/dev/src/core/synthetic.ts :: const READY = "ready-for-agent";']);

    const readDefault = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ['const label = input?.label ?? "ready-for-agent";', 'type Action = "heal" | "quarantine";'].join("\n"),
    );
    expect(readDefault).toEqual([]);
  });

  it("closes the LABEL_READY_FOR_AGENT word-boundary hole without flagging the review lane", () => {
    const portified = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ["await gh.editLabels(issue, [LABEL_READY_FOR_AGENT], []);"].join("\n"),
    );
    expect(portified).toHaveLength(1);

    const reviewLane = scanSource(
      "apps/dev/src/core/synthetic.ts",
      ["await gh.editLabels(pr, [LABEL_READY_FOR_REVIEW], []);"].join("\n"),
    );
    expect(reviewLane).toEqual([]);
  });

  it("does not flag the port's own implementation, guard body included (#2894)", () => {
    const port = scanSource(
      "apps/dev/src/runtime/gh/synthetic.ts",
      [
        "export async function editLabels(",
        "  ctx: GhContext,",
        "  issue: number,",
        "  remove: string[],",
        "  add: string[],",
        "): Promise<boolean> {",
        "  if (add.includes(LABEL_READY)) {",
        '    const refusal = laneIsolationRefusal("direct label write", next);',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(port).toEqual([]);
  });

  it("does not flag planner-backed transitions", () => {
    const compliant = scanSource(
      "apps/dev/src/core/synthetic.ts",
      [
        'await transitionLabels((r, a) => gh.editLabels(issue, r, a), labels, { kind: "queue" });',
        'await editIssueLifecycleLabels(deps, issue, [LABEL_RUNNING], [LABEL_RUNNING], [LABEL_READY], "retry");',
      ].join("\n"),
    );
    expect(compliant).toEqual([]);
  });

  it("planner-backed wrappers still route through the planner", () => {
    const recovery = readFileSync(join(HERE, "..", "src", "core", "process-issue", "recovery.ts"), "utf8");
    expect(recovery).toContain("transitionLabels(");
    expect(recovery).toContain("lifecycleTransitionFor(");
  });

  it("every raw state-role writer in engine source is allowlisted", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const root of SCAN_ROOTS) {
      for (const file of walk(root.dir)) {
        const rel = relative(root.dir, file).replaceAll("\\", "/");
        const path = `${root.label}/${rel}`;
        for (const key of scanSource(path, readFileSync(file, "utf8"))) {
          seen.add(key);
          if (!ALLOWLIST.has(key)) offenders.push(key);
        }
      }
    }
    expect(
      offenders,
      `raw state-role label edits outside the transition API:\n${offenders.join("\n")}\n` +
        "Route the mutation through planTransition/applyTransition (core/state-transition.ts) " +
        "or allowlist it in state-transition-contract.test.ts with a reason.",
    ).toEqual([]);

    // Stale allowlist entries rot into false confidence — prune them.
    const stale = [...ALLOWLIST.keys()].filter((key) => !seen.has(key));
    expect(stale, `allowlist entries no longer present in source:\n${stale.join("\n")}`).toEqual([]);
  });

  it("the temporary castle file allowlist names its Wave C expiry and still applies", () => {
    for (const [path, reason] of FILE_ALLOWLIST) {
      expect(reason, `${path} must say when its exemption ends`).toMatch(/Wave C/);
      const root = SCAN_ROOTS.find((r) => path.startsWith(`${r.label}/`));
      expect(root, `${path} is not under a scanned root`).toBeDefined();
      const file = join(root!.dir, path.slice(root!.label.length + 1));
      // A file exemption that names a moved / already-migrated file exempts
      // nothing and reads as coverage it no longer provides — prune it.
      const survivors = collectWriters(path, readFileSync(file, "utf8"));
      expect(
        survivors.length,
        `${path} no longer has a raw state-role writer — drop its exemption`,
      ).toBeGreaterThan(0);
    }
  });
});
