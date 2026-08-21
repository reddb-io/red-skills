/**
 * mutation-operators — the deterministic mutator, restricted to changed lines.
 *
 * A green suite proves that the code passes the tests. It does not prove that
 * the tests would notice if the code were wrong, and that second question is
 * the one an autonomous drain cannot ask a human. Mutation testing asks it
 * mechanically: change one operator, re-run the tests, and see whether anything
 * goes red. A mutant nothing kills is a line the suite does not actually judge.
 *
 * Two properties make this affordable inside a publish rather than a nightly
 * job, and both are structural rather than tuned:
 *
 *   1. **Diff-scoped.** Only nodes whose token sits on a line the diff touched
 *      are mutated. Full-repo mutation is a different product with a different
 *      budget (Spec #4129 puts it out of scope); the question at publish is
 *      whether THIS change is tested.
 *   2. **Deterministic.** The operator table is closed, the walk is source
 *      order, and the cap is a prefix of a stable ordering — so the same diff
 *      yields the same mutants on every machine. A sampler that picked
 *      differently per run would make the gate's verdict depend on luck, and a
 *      flaky blocker is a blocker operators turn off.
 *
 * The operators are the classic minimal set — boundary, negation, arithmetic,
 * logical, boolean literal — chosen because each one is a single token swap
 * that stays syntactically valid, so a mutant never fails for being unparseable
 * and a "killed" result always means the tests actually noticed the behaviour
 * change.
 *
 * **This is the ONE module in the check that imports the compiler**, which is
 * why it holds nothing but the walk: the parser may not reach the shipped
 * bundle, so anything a bundled surface needs — the mutant model, applying a
 * mutant, describing one — lives in `mutation-plan.ts` instead. PURE: this
 * module takes text and gives back mutants, and never runs anything.
 */
import ts from "typescript";

import {
  DEFAULT_MAX_MUTANTS,
  type Mutant,
  type MutationOperatorId,
  type MutationPlanOptions,
  type MutationSource,
} from "./mutation-plan.js";

/**
 * The binary-operator swap table, keyed by the token being replaced.
 *
 * Both directions of every pair are listed, because a mutator that only widened
 * `<` to `<=` would leave every `<=` in the diff unjudged — and the boundary
 * bug lives on whichever side the author happened to write.
 */
const BINARY_SWAPS = new Map<ts.SyntaxKind, { kind: ts.SyntaxKind; operator: MutationOperatorId }>([
  [ts.SyntaxKind.LessThanToken, { kind: ts.SyntaxKind.LessThanEqualsToken, operator: "conditional-boundary" }],
  [ts.SyntaxKind.LessThanEqualsToken, { kind: ts.SyntaxKind.LessThanToken, operator: "conditional-boundary" }],
  [ts.SyntaxKind.GreaterThanToken, { kind: ts.SyntaxKind.GreaterThanEqualsToken, operator: "conditional-boundary" }],
  [ts.SyntaxKind.GreaterThanEqualsToken, { kind: ts.SyntaxKind.GreaterThanToken, operator: "conditional-boundary" }],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, { kind: ts.SyntaxKind.ExclamationEqualsEqualsToken, operator: "negate-conditional" }],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, { kind: ts.SyntaxKind.EqualsEqualsEqualsToken, operator: "negate-conditional" }],
  [ts.SyntaxKind.EqualsEqualsToken, { kind: ts.SyntaxKind.ExclamationEqualsToken, operator: "negate-conditional" }],
  [ts.SyntaxKind.ExclamationEqualsToken, { kind: ts.SyntaxKind.EqualsEqualsToken, operator: "negate-conditional" }],
  [ts.SyntaxKind.PlusToken, { kind: ts.SyntaxKind.MinusToken, operator: "arithmetic" }],
  [ts.SyntaxKind.MinusToken, { kind: ts.SyntaxKind.PlusToken, operator: "arithmetic" }],
  [ts.SyntaxKind.AsteriskToken, { kind: ts.SyntaxKind.SlashToken, operator: "arithmetic" }],
  [ts.SyntaxKind.SlashToken, { kind: ts.SyntaxKind.AsteriskToken, operator: "arithmetic" }],
  [ts.SyntaxKind.AmpersandAmpersandToken, { kind: ts.SyntaxKind.BarBarToken, operator: "logical" }],
  [ts.SyntaxKind.BarBarToken, { kind: ts.SyntaxKind.AmpersandAmpersandToken, operator: "logical" }],
]);

/**
 * Every mutant one file's changed lines admit, in source order. PURE — takes
 * text, touches no filesystem, runs nothing.
 *
 * A token is eligible when its OWN line was touched, not when its enclosing
 * statement was: a diff that changed the second line of a three-line condition
 * did not change the first, and mutating the untouched half would report on
 * test coverage this publish is not responsible for.
 */
export function planFileMutants(source: MutationSource): Mutant[] {
  const changed = new Set(source.changedLines);
  if (changed.size === 0) return [];

  const file = ts.createSourceFile(
    source.path.endsWith(".ts") ? source.path : `${source.path}.ts`,
    source.text,
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: Omit<Mutant, "id">[] = [];

  const lineOf = (position: number): number =>
    file.getLineAndCharacterOfPosition(position).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const swap = BINARY_SWAPS.get(node.operatorToken.kind);
      const start = node.operatorToken.getStart(file);
      const line = lineOf(start);
      if (swap !== undefined && changed.has(line)) {
        found.push({
          path: source.path,
          line,
          operator: swap.operator,
          original: ts.tokenToString(node.operatorToken.kind) ?? "",
          replacement: ts.tokenToString(swap.kind) ?? "",
          start,
          end: node.operatorToken.getEnd(),
        });
      }
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const start = node.getStart(file);
      const line = lineOf(start);
      if (changed.has(line)) {
        found.push({
          path: source.path,
          line,
          operator: "boolean-literal",
          original: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false",
          replacement: node.kind === ts.SyntaxKind.TrueKeyword ? "false" : "true",
          start,
          end: node.getEnd(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  found.sort((a, b) => a.start - b.start);
  return found.map((mutant, ordinal) => ({
    ...mutant,
    id: `${mutant.path}:${mutant.line}:${mutant.operator}#${ordinal}`,
  }));
}

/**
 * The publish's whole mutant plan: every file's mutants, INTERLEAVED, then cut
 * to the ceiling. PURE.
 *
 * Interleaving is the load-bearing part. Concatenating file by file and taking
 * the first N spends the entire budget on whichever file sorts first, so a diff
 * touching one large module and three small ones would judge only the large one
 * and report a score for the change as a whole. Round-robin spends the same
 * budget across every file the diff touched, and stays deterministic because
 * both the file order and each file's order are fixed.
 */
export function planMutants(
  sources: readonly MutationSource[],
  options: MutationPlanOptions = {},
): Mutant[] {
  const ceiling = options.maxMutants ?? DEFAULT_MAX_MUTANTS;
  if (ceiling <= 0) return [];

  const byFile = [...sources]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((source) => planFileMutants(source));

  const plan: Mutant[] = [];
  const deepest = byFile.reduce((max, list) => Math.max(max, list.length), 0);
  for (let round = 0; round < deepest && plan.length < ceiling; round += 1) {
    for (const list of byFile) {
      if (plan.length >= ceiling) break;
      const mutant = list[round];
      if (mutant !== undefined) plan.push(mutant);
    }
  }
  return plan;
}
