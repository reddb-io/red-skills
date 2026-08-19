/**
 * provision-fix — the canonical repair sentence, in one leaf module.
 *
 * It lives apart from `provision.ts` because the surface that most needs it is
 * the CLIENT, and a client that had to import the provisioner to print one
 * sentence would drag the daemon's whole boot story behind it. `provision.ts`
 * re-exports the constant, so the sentence still has exactly one author.
 */
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";

/**
 * The canonical fix, in one string, so every surface prints the same sentence.
 *
 * The direct form is spelled as the ADR 0091 npm direct-run invocation rather
 * than a bare `redskilled`, because this line is printed exactly when the host
 * has no working daemon — and therefore no reason to have a shim for one on
 * PATH. A hint that names its own precondition is the #2961 dead end (#3071).
 */
export const REDSKILLED_PROVISION_FIX =
  "run `/red-setup` (Section E3 — execution daemon), or " +
  `\`${canonicalInvocation("red-skills-redskilled", ["provision"])}\` directly`;
