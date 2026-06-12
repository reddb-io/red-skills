// trust-gate — the AFK "executable issue" trust gate (ADR 0056, issue #621).
//
// A PURE predicate over three inputs resolved at claim time:
//   - the issue AUTHOR (the `gh issue view --json author` login),
//   - the ACTOR who applied `ready-for-agent` (read from the issue TIMELINE —
//     never inferred from the mutable label set),
//   - the per-repo ALLOWLIST from plugin config (`plugins.dev.afk.trust-gate.*`,
//     folded to the bare `afk.trust-gate.*` accessor per ADR 0042).
//
// An issue is EXECUTABLE only when BOTH hold:
//   1. the author is a trusted identity (in the allowlist), AND
//   2. `ready-for-agent` was applied by an allowlisted actor (in the allowlist).
//
// When no allowlist is configured the gate is PERMISSIVE — it returns executable
// for everything, preserving today's single-maintainer behaviour EXACTLY.
// Configuring the allowlist switches the repo to strict mode. A `ready-for-agent`
// applied by a non-allowlisted actor (an automation bot, an untrusted reporter)
// is ignored by selection/claim and may be stripped by a sweep with an audit
// comment (`planTrustStrip`).
//
// IO-free: the runtime resolves the provenance (author + label actor) through gh
// and passes it in; this module only DECIDES.

import type { ConfigValues } from "./config.js";
import { getConfig } from "./config.js";

/** The accessor key the allowlist lives under (folded from
 * `plugins.dev.afk.trust-gate.allowlist`, ADR 0042). Intentionally NOT in
 * `CONFIG_DEFAULTS`: its default is *unset* (absent → permissive), and a "" entry
 * there would break the "every default is non-empty" invariant — same treatment
 * as `dev.lock.branch`. */
export const TRUST_ALLOWLIST_KEY = "afk.trust-gate.allowlist";

/** The parsed per-repo trust policy. `enabled` is DERIVED: the gate is active
 * only when the allowlist is non-empty (absent config → permissive). */
export interface TrustPolicy {
  /** True when an allowlist is configured (strict mode). */
  enabled: boolean;
  /** The set of trusted GitHub logins — both the author AND the label actor are
   * checked against this single list. */
  allowlist: readonly string[];
}

/** Provenance resolved from gh at claim time. Either field may be undefined when
 * the gh read failed or the timeline carried no `labeled` event for the label. */
export interface TrustProvenance {
  /** Issue author login (`gh issue view --json author`). */
  author?: string;
  /** Login of the actor who applied `ready-for-agent`, read from the timeline. */
  readyForAgentActor?: string;
}

/** The gate verdict. `reason` is set only when NOT executable (for the log line
 * and the sweep's audit comment). */
export interface TrustVerdict {
  executable: boolean;
  reason?: string;
}

/** Parse a comma / whitespace / newline-separated login list into a trimmed,
 * de-duped set. A leading `@` (how logins are often written in issues) is dropped
 * so `@alice` and `alice` collapse to one entry. */
function parseLogins(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\s]+/)) {
    const login = part.trim().replace(/^@/, "");
    if (login) seen.add(login);
  }
  return [...seen];
}

/**
 * Read the trust policy from the loaded config map. An empty / absent allowlist
 * yields `enabled:false` → permissive (today's behaviour).
 */
export function parseTrustPolicy(values: ConfigValues): TrustPolicy {
  const allowlist = parseLogins(getConfig(values, TRUST_ALLOWLIST_KEY));
  return { enabled: allowlist.length > 0, allowlist };
}

/**
 * The pure gate predicate. PERMISSIVE when the policy is disabled (no allowlist);
 * otherwise BOTH the author and the label actor must be in the allowlist. The
 * author is checked first, so a trusted author promoted by an automation/untrusted
 * actor is reported against the actor, and an untrusted author against the author.
 */
export function evaluateTrustGate(policy: TrustPolicy, provenance: TrustProvenance): TrustVerdict {
  if (!policy.enabled) return { executable: true };

  const allow = new Set(policy.allowlist);
  const author = (provenance.author ?? "").trim();
  const actor = (provenance.readyForAgentActor ?? "").trim();

  if (!author || !allow.has(author)) {
    return {
      executable: false,
      reason: `untrusted author ${author ? `'${author}'` : "(unknown)"} — not in the trust-gate allowlist`,
    };
  }
  if (!actor || !allow.has(actor)) {
    return {
      executable: false,
      reason: `ready-for-agent applied by ${actor ? `'${actor}'` : "an unknown actor"} — not in the trust-gate allowlist`,
    };
  }
  return { executable: true };
}

/** A `ready-for-agent` candidate the strip sweep examines: its number + the
 * provenance resolved from gh. */
export interface TrustSweepCandidate {
  number: number;
  provenance: TrustProvenance;
}

/** A planned strip: remove `ready-for-agent` from `number` and post `comment`. */
export interface TrustStripPlan {
  number: number;
  reason: string;
  /** The audit comment body explaining the strip. */
  comment: string;
}

/**
 * Plan the trust-gate STRIP sweep. For each candidate whose provenance fails the
 * gate, emit a plan to remove `ready-for-agent` and post an audit comment. A
 * no-op (empty plan) when the policy is permissive — a repo with no allowlist
 * never strips anything, preserving today's behaviour. PURE: the caller applies
 * the label edit + comment through gh.
 */
export function planTrustStrip(
  policy: TrustPolicy,
  candidates: readonly TrustSweepCandidate[],
): TrustStripPlan[] {
  if (!policy.enabled) return [];
  const plans: TrustStripPlan[] = [];
  for (const c of candidates) {
    const verdict = evaluateTrustGate(policy, c.provenance);
    if (verdict.executable) continue;
    const reason = verdict.reason ?? "not an executable issue";
    plans.push({
      number: c.number,
      reason,
      comment:
        `🤖 /afk trust gate: stripped \`ready-for-agent\` — ${reason}. ` +
        `Re-author this through triage (a maintainer must re-create or promote it) to make it executable.`,
    });
  }
  return plans;
}
