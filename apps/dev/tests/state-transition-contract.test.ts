// state-transition-contract.test.ts — the transition-API contract lint (#2528,
// ADR 0122 rule 5).
//
// Engine code must not hand-roll issue STATE-ROLE label edits: every mutation
// that queues, parks, promotes, quarantines, or dependency-blocks an issue
// flows through `planTransition`/`applyTransition` so the one-state-role
// invariant is proven at plan time. This test scans the engine source for raw
// `editLabels(` call sites whose arguments mention a state-role label and
// fails on any site that is not in the explicit allowlist below.
//
// Adding a NEW raw state-label edit fails this test by design — route it
// through the transition API, or (for a genuinely justified survivor: a
// documented legacy fallback, a non-issue surface like PR review labels, or a
// human/manual command surface) add it to the allowlist WITH a reason.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** State-role vocabulary (constants, literals, and injected-config accessors)
 * that marks an edit as a STATE mutation. `running`/`contested`/typed
 * `blocked:*` reasons alone are projections or modifiers, not state roles.
 *
 * The `<config>.ready` / `.human` / `.dependency` accessors keep PORTIFIED
 * engine code covered (#2665): a module that reads its label vocabulary from an
 * injected `TriageLabelConfig` instead of value-importing `LABEL_*` would
 * otherwise fall out of this scan entirely and take its call sites with it. */
const STATE_ROLE_PATTERN =
  /LABEL_READY\b|LABEL_HUMAN\b|LABEL_QUARANTINE\b|LABEL_TRIAGE\b|LABEL_NEEDS_INFO\b|LABEL_DEPENDENCY\b|\blabels\.(ready|human|quarantine|needsTriage|needsInfo|dependency)\b|"ready-for-agent"|"ready-for-human"|"needs-triage"|"needs-info"|"quarantine"|"blocked:dependency"/;

/**
 * Surviving raw call sites, keyed `relative-path :: normalized-statement`.
 * Every entry must carry a reason. Shrinking this list is progress; growing it
 * needs the same justification bar as a new ADR 0122 exception.
 */
const ALLOWLIST = new Map<string, string>([
  // --- documented legacy fallbacks (labels unavailable at the call site) ---
  [
    "core/boot-sweep.ts :: await gh.editLabels(p.number, [remove, ...p.reqLabels], [LABEL_READY]);",
    "unblock-sweep fallback when the candidate's labels were not listed (#2528)",
  ],
  [
    "core/process-issue/terminal.ts :: await deps.gh.editLabels(p.number, [LABEL_DEPENDENCY, ...p.reqLabels], [LABEL_READY]);",
    "close-cascade fallback when the dependent's labels were not listed (#2528)",
  ],
  [
    "core/supervisor/envelopes.ts :: if (!applied) await deps.gh.editLabels(info.issue, disp.addLabels, [...disp.removeLabels, LABEL_READY]);",
    "death-sweep legacy retry fallback when labels unknown (#2526)",
  ],
  [
    "core/supervisor/reaper.ts :: await deps.gh.editLabels(info.issue, disp.addLabels, [...disp.removeLabels, LABEL_READY]);",
    "stall-reaper retry envelope; same dispose vocabulary as the death-sweep, migration tracked by ADR 0122 rule 7",
  ],
  // --- claim machinery: ready<->running swaps are claims, not state transitions ---
  [
    "core/supervisor/reaper.ts :: await deps.gh.editLabels(contest.issue, [LABEL_READY], [LABEL_RUNNING, LABEL_CONTESTED]);",
    "reap-contest claim swap; claim vocabulary, not a state transition",
  ],
  [
    "core/supervisor/reaper.ts :: await deps.gh.editLabels( pair.issue, [LABEL_READY, LABEL_RUNNER_ERROR], [LABEL_HUMAN, LABEL_RUNNING], );",
    "half-open probe re-claim of a runner-error park; claim machinery",
  ],
  // --- ADR 0055 reconcile lane: deliberate typed parks over pre-read labels ---
  [
    "core/reconcile.ts :: await deps.gh.editLabels(issue, parkDropLabels(labels, deps.labels), [deps.labels.human, typed]);",
    "reconcile typed park; parkDropLabels collapses stale state first",
  ],
  [
    "core/reconcile.ts :: await deps.gh.editLabels(p.number, [deps.labels.dependency, ...p.reqLabels], [deps.labels.ready]);",
    "reconcile-lane cascade mirror; migration tracked by ADR 0122 rule 7",
  ],
  // --- non-issue surfaces: PR review-lane labels, not issue state ---
  [
    "core/review.ts :: await gh.editLabels(pr, [LABEL_RUNNING], [LABEL_HUMAN]);",
    "PR review-lane labels, not issue state",
  ],
  [
    "core/review.ts :: await gh.editLabels(pr, [LABEL_RUNNING], [LABEL_VALIDATION, LABEL_HUMAN]);",
    "PR review-lane labels, not issue state",
  ],
  // --- companion drift correction: exposed once the local label copies died (#2661) ---
  [
    "runtime/companion-io.ts :: await ghx.editLabels(options.ctx, id.issue, [], has(LABEL_READY) ? [] : [LABEL_READY]);",
    "migrated to planTransition in #2663",
  ],
  [
    "runtime/companion-io.ts :: await ghx.editLabels( options.ctx, id.issue, has(LABEL_READY) ? [LABEL_READY] : [], has(LABEL_HUMAN) ? [] : [LABEL_HUMAN], );",
    "migrated to planTransition in #2663",
  ],
  // --- human/manual command surfaces (outside the engine contract by design) ---
  [
    "commands/requeue.ts :: await gh.editLabels(input.issue, [LABEL_READY], []);",
    "/requeue is a maintainer command surface (#2509 tracks its own fix)",
  ],
  [
    "commands/requeue.ts :: if (readyWithheld) await gh.editLabels(input.issue, [], [LABEL_READY]);",
    "/requeue is a maintainer command surface (#2509 tracks its own fix)",
  ],
  [
    "commands/stop.ts :: await ghx.editLabels(ghCtx, issue, [LABEL_RUNNING], [LABEL_READY]);",
    "fleet-stop operator reconcile; runs under explicit human intent",
  ],
]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) yield path;
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

describe("transition-API contract lint (#2528)", () => {
  it("every raw state-role editLabels call site in engine source is allowlisted", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (!/\beditLabels\(/.test(line)) continue;
        // Declarations / interface members are not call sites.
        if (/editLabels\??\(issue: |editLabels\??\(pr: |editLabels\(candidate: /.test(line)) continue;
        const statement = statementAt(lines, i);
        if (!STATE_ROLE_PATTERN.test(statement)) continue;
        const key = `${rel} :: ${statement}`;
        seen.add(key);
        if (!ALLOWLIST.has(key)) offenders.push(key);
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
});
