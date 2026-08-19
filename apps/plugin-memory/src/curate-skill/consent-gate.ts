/**
 * consent-gate — pure decider for which archive candidates the user actually
 * approved. The /curate skill collects approvals as a set of skill names; the
 * gate intersects them with the read candidates so an unknown / typo'd name
 * never reaches the engine.
 */
import type { ArchiveCandidate, ConsentDecision } from "./types.js";

export function decideConsent(
  candidates: readonly ArchiveCandidate[],
  approved: ReadonlySet<string>,
): ConsentDecision {
  const approvedOut: ArchiveCandidate[] = [];
  const declinedOut: ArchiveCandidate[] = [];
  for (const c of candidates) {
    if (approved.has(c.name)) approvedOut.push(c);
    else declinedOut.push(c);
  }
  return { approved: approvedOut, declined: declinedOut };
}
