/**
 * Intentionally red ownership draft for ADR 0102 / Ticket #2233.
 *
 * This file uses a `.draft.ts` suffix, outside Vitest's CI include, while the
 * migration is in progress. Run it directly with:
 *
 *   pnpm --filter @reddb-io/dev exec tsx tests/castle-entry-point-drift.draft.ts
 *
 * It becomes green monotonically: every castle relocation removes findings;
 * no current-tree verb inventory needs to be rewritten along the way.
 */
import {
  currentTreeEngineVerbs,
  currentTreeFindings,
  renderFindings,
} from "./support/castle-entry-point-drift.js";

const findings = currentTreeFindings();
const retainedVerbs = currentTreeEngineVerbs();

if (findings.length > 0 || retainedVerbs.length > 0) {
  throw new Error(
    [
      `Retained dev orchestration verbs: ${retainedVerbs.join(", ") || "none"}`,
      "apps/plugin-dev/src control flow over castle engine entities:",
      renderFindings(findings) || "none",
    ].join("\n"),
  );
}
