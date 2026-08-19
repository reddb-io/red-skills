// state-transition-contract.test.ts — the transition-API contract lint for the
// CASTLE tree (#2528, #2664, #2666; red-skills ADR 0122 rule 5).
//
// The consuming host runs the same lint over its own `src` tree
// (`apps/dev/tests/state-transition-contract.test.ts`); this one keeps the
// engine's tree honest from the engine's own suite, so a castle-only change can
// never introduce a raw state-role write that only the host's CI would catch.
//
// Engine code must not hand-roll issue STATE-ROLE label edits: every mutation
// that queues, parks, promotes, quarantines, or dependency-blocks an issue
// flows through `planTransition`/`applyTransition` so the one-state-role
// invariant is proven at plan time. This test scans the engine source for raw
// `editIssueLabels(` / `editLabels(` call sites whose arguments mention a
// state-role label and fails on any site that is not in the allowlist below.
//
// The allowlist is EMPTY and stays empty: castle's two raw writers (the
// quarantine curator and the dependency cascade) were migrated in #2666, and a
// new raw state-label edit here is a defect, not a survivor to be documented.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The spellings a state role can carry. `running` and typed `blocked:*`
 * reasons alone are projections or modifiers, not state roles. */
const STATE_ROLE_LITERAL =
  /"(ready-for-agent|ready-for-human|needs-triage|needs-info|quarantine|blocked:dependency)"/;

/** State-role vocabulary as it appears at a mutation site. Two forms must be
 * caught, because castle's two pre-migration writers used one each:
 *
 *  - `<config>.ready` / `.human` / `.dependencyBlocked` — the PORTIFIED form.
 *    Castle modules read their vocabulary from an injected
 *    `EngineLabelVocabulary`, so a literal-only scan would miss the dependency
 *    cascade's `removeLabels: [labels.dependencyBlocked, …]` entirely.
 *  - a file-local `const NAME = "<state role>"` — the form the quarantine
 *    curator used (`const QUARANTINE = "quarantine"`, then
 *    `remove: [QUARANTINE, READY]`). Resolving these per file is what gives the
 *    lint teeth against a writer that launders the spelling through a constant. */
const CONFIG_ACCESSOR =
  /\blabels\.(ready|human|quarantine|needsTriage|needsInfo|dependencyBlocked)\b/;

/** The shapes that WRITE a label delta — a state-role token inside one of these
 * is a raw mutation; the same token in a read or a comparison is not. */
const MUTATION_MARKER = /\beditIssueLabels\(|\beditLabels\(|\bremoveLabels:|\baddLabels:/;

/** File-local constants bound to a state-role spelling, as a token pattern. */
function localRoleConstants(source: string): RegExp | undefined {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*("[^"]*")/.exec(line);
    if (match && STATE_ROLE_LITERAL.test(match[2]!)) names.push(match[1]!);
  }
  return names.length > 0 ? new RegExp(`\\b(${names.join("|")})\\b`) : undefined;
}

/**
 * Surviving raw call sites, keyed `relative-path :: normalized-statement`.
 * Empty by contract (#2666) — route the mutation through the transition API
 * instead of growing this list.
 */
const ALLOWLIST = new Map<string, string>();

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts") && !path.endsWith(".test.ts")) {
      yield path;
    }
  }
}

/** Collapse a multi-line call statement to one normalized single-space line,
 * reporting the last line it consumed so the scan does not report the same
 * mutation twice (a `removeLabels:`/`addLabels:` pair is ONE site). */
function statementAt(lines: string[], index: number): { statement: string; end: number } {
  let statement = lines[index]!;
  let cursor = index;
  while (!statement.includes(");") && cursor + 1 < lines.length && cursor - index < 6) {
    cursor += 1;
    statement += ` ${lines[cursor]!}`;
  }
  return { statement: statement.replace(/\s+/g, " ").trim(), end: cursor };
}

/** Every raw state-role mutation site in `source`, normalized one per line. */
export function rawStateRoleMutations(source: string): string[] {
  const localConst = localRoleConstants(source);
  const lines = source.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!MUTATION_MARKER.test(line)) continue;
    // Declarations / interface members are not call sites.
    if (/editIssueLabels\??\(issue: |editLabels\??\(issue: /.test(line)) continue;
    const { statement, end } = statementAt(lines, i);
    const raw =
      CONFIG_ACCESSOR.test(statement) ||
      STATE_ROLE_LITERAL.test(statement) ||
      (localConst?.test(statement) ?? false);
    if (raw) {
      found.push(statement);
      i = end;
    }
  }
  return found;
}

describe("transition-API contract lint — castle tree (#2666)", () => {
  it("no raw state-role label edit survives in engine source", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of walk(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replaceAll("\\", "/");
      for (const statement of rawStateRoleMutations(readFileSync(file, "utf8"))) {
        const key = `${rel} :: ${statement}`;
        seen.add(key);
        if (!ALLOWLIST.has(key)) offenders.push(key);
      }
    }
    expect(
      offenders,
      `raw state-role label edits outside the transition API:\n${offenders.join("\n")}\n` +
        "Route the mutation through planTransition/applyTransition " +
        "(engine/state-transition.ts). The castle allowlist is empty by contract.",
    ).toEqual([]);

    // Stale allowlist entries rot into false confidence — prune them.
    const stale = [...ALLOWLIST.keys()].filter((key) => !seen.has(key));
    expect(stale, `allowlist entries no longer present in source:\n${stale.join("\n")}`).toEqual([]);
  });

  // A lint nobody has watched fail is a lint nobody can trust. These rows are
  // castle's two ACTUAL pre-migration writers, verbatim.
  it("catches the curator's laundered-constant writer", () => {
    const source = [
      'const QUARANTINE = "quarantine";',
      'const READY = "ready-for-agent";',
      "await input.tracker.editIssueLabels(issue.number, {",
      "  remove: [QUARANTINE],",
      "  add: [READY],",
      "});",
    ].join("\n");
    expect(rawStateRoleMutations(source)).toHaveLength(1);
  });

  it("catches the dependency cascade's injected-config writer", () => {
    const source = [
      "plans.push({",
      "  removeLabels: [",
      "    labels.dependencyBlocked,",
      "    ...labelDeps.map((dependency) => labelForDependency(dependency, labels)),",
      "  ],",
      "  addLabels: [labels.ready],",
      "});",
    ].join("\n");
    expect(rawStateRoleMutations(source)).toHaveLength(1);
  });

  it("leaves a transition-planned write and a plain read alone", () => {
    const source = [
      "const issues = await tracker.listOpenIssuesByLabel(labels.quarantine);",
      "if (!candidate.labels.includes(labels.dependencyBlocked)) continue;",
      "await tracker.editIssueLabels(plan.issue, {",
      "  remove: [...plan.remove],",
      "  add: [...plan.add],",
      "});",
    ].join("\n");
    expect(rawStateRoleMutations(source)).toEqual([]);
  });
});
