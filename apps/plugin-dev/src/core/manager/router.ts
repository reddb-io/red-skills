// core/manager/router.ts — the ask-red routing table, structured as data for
// the Manager to consume (Spec #2290, slice #2293; architecture in ADR 0109).
//
// The classification of *intent text* into a skill is ask-red's job (done at
// the SKILL.md/agent layer via /ask-red). This module answers a different
// question: given a skill name that ask-red returned, is it session-bound or
// autonomous? That split is Spec #2290 Decision #2182, and this module is its
// canonical encoding.
//
// Manager consumes this table — it does not re-implement the classifier or make
// the operator choose a Skill when the inventory already has an answer. That is
// the ADR 0109 constraint: "it does not copy the classifier".

/**
 * How a skill integrates with the Manager session.
 *
 * `session-bound` — runs inline in the Manager's operator session; the Manager
 *   holds the conversation, the skill runs as a subroutine, and the artifact
 *   reference is captured into the effort.
 *
 * `autonomous` — dispatched to a separate execution lane (afk, go); the Manager
 *   reconciles the outcome from the tracker rather than waiting inline.
 *
 * `unknown` — a skill not in the ask-red routing table (should not appear in
 *   normal use; surfaced for diagnostics only).
 */
export type RouteKind = "session-bound" | "autonomous" | "unknown";

// Skills that run inline as subroutines in the Manager session.
// Source: Spec #2290 Decision #2182 (start, research, to-spec, to-tickets).
const SESSION_BOUND_SKILLS: ReadonlySet<string> = new Set([
  "start",
  "research",
  "to-spec",
  "to-tickets",
]);

// Skills that are dispatched and then reconciled from the tracker.
// Source: Spec #2290 Decision #2182 (afk, go).
const AUTONOMOUS_SKILLS: ReadonlySet<string> = new Set(["afk", "go"]);

/**
 * Classify a skill name from ask-red's routing inventory into a route kind.
 *
 * This is the ask-red split encoded as data — not a re-implementation of
 * ask-red's intent classifier, which runs at the agent/SKILL.md layer.
 */
export function classifyRouteKind(skill: string): RouteKind {
  if (SESSION_BOUND_SKILLS.has(skill)) return "session-bound";
  if (AUTONOMOUS_SKILLS.has(skill)) return "autonomous";
  return "unknown";
}

/** True for a skill that runs inline in the Manager session. */
export function isSessionBound(skill: string): boolean {
  return classifyRouteKind(skill) === "session-bound";
}
