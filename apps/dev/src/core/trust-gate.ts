// trust-gate — the AFK "executable issue" trust gate (ADR 0085, issue #621).
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
// When no allowlist is configured the DEFAULT posture is repository-visibility
// aware (issue #1101, parent #1099):
//   - PRIVATE / single-collaborator repo → PERMISSIVE: executable for everything,
//     preserving today's single-maintainer ergonomics EXACTLY.
//   - PUBLIC repo → FAIL-CLOSED: a `ready-for-agent` from an untrusted author OR
//     an untrusted promoter is HELD for a maintainer summon rather than auto-claimed.
//     "Untrusted" reuses the dynamic maintainer signal (`resolveActorTrust`:
//     write-access / CODEOWNERS / allowlist), not a new trust matrix.
// Configuring the allowlist switches the repo to STRICT mode on either visibility:
// BOTH the author and the promoter must be allowlisted. A `ready-for-agent`
// applied by a non-allowlisted actor (an automation bot, an untrusted reporter)
// is ignored by selection/claim and may be stripped by a sweep with an audit
// comment (`planTrustStrip`).
//
// IO-free: the runtime resolves the provenance (author + label actor) through gh
// and passes it in; this module only DECIDES.

import type { ConfigValues } from "./config.js";
import { getConfig } from "./config.js";
import type { SourceTrustLevel } from "./source-trust.js";
import {
  composeRepair,
  externalApprovalRepair,
  noRepair,
  type RepairAction,
  type RepairSource,
} from "@reddb-io/shared/repair.js";

/** The accessor key the allowlist lives under (folded from
 * `plugins.dev.afk.trust-gate.allowlist`, ADR 0042). Intentionally NOT in
 * `CONFIG_DEFAULTS`: its default is *unset* (absent → permissive), and a "" entry
 * there would break the "every default is non-empty" invariant — same treatment
 * as `dev.lock.branch`. */
export const TRUST_ALLOWLIST_KEY = "afk.trust-gate.allowlist";

/** GitHub repository visibility, as reported by `gh repo view --json visibility`
 * (lower-cased). `undefined` when the read failed or was not attempted — treated
 * as NON-public, so an undeterminable visibility keeps the permissive default. */
export type RepoVisibility = "public" | "private" | "internal";

/** The active default posture when NO allowlist is configured, surfaced so an
 * operator can tell at a glance which way the gate leans:
 *   - `strict`      — an allowlist IS configured (visibility-independent);
 *   - `fail-closed` — no allowlist + a PUBLIC repo → untrusted work is held;
 *   - `permissive`  — no allowlist + a private/undeterminable repo → today's default. */
export type TrustPosture = "strict" | "fail-closed" | "permissive";

/** The parsed per-repo trust policy. `enabled` is DERIVED: the gate is active
 * only when the allowlist is non-empty (absent config → visibility-aware default).
 * `failClosed` is DERIVED: no allowlist AND a public repo (issue #1101). */
export interface TrustPolicy {
  /** True when an allowlist is configured (strict mode). */
  enabled: boolean;
  /** The set of trusted GitHub logins — both the author AND the label actor are
   * checked against this single list. */
  allowlist: readonly string[];
  /** Repository visibility folded into the policy (drives `failClosed`). Optional
   * so legacy callers/tests that predate the visibility dimension omit it → they
   * default to the permissive posture, preserving today's behaviour EXACTLY. */
  visibility?: RepoVisibility;
  /** DERIVED: no allowlist + a PUBLIC repo → the untrusted-default is fail-closed.
   * Optional/absent → false (permissive), so pre-#1101 `TrustPolicy` literals keep
   * their exact meaning. */
  failClosed?: boolean;
}

/** The active {@link TrustPosture} for a policy — the operator-facing "which way
 * does the gate lean" descriptor (acceptance: the posture is discernible). */
export function describeTrustPosture(policy: TrustPolicy): TrustPosture {
  if (policy.enabled) return "strict";
  return policy.failClosed ? "fail-closed" : "permissive";
}

/** Provenance resolved from gh at claim time. Either field may be undefined when
 * the gh read failed or the timeline carried no `labeled` event for the label. */
export interface TrustProvenance {
  /** Issue author login (`gh issue view --json author`). */
  author?: string;
  /**
   * Source-trust level for the issue author (issue #1100 taxonomy). When present,
   * process-issue can distinguish trusted-author work from untrusted-author work
   * even when the executable-issue trust gate is permissive.
   */
  authorSourceTrust?: SourceTrustLevel;
  /** Login of the actor who applied `ready-for-agent`, read from the timeline. */
  readyForAgentActor?: string;
}

/** The gate verdict. `reason` is set only when NOT executable (for the log line
 * and the sweep's audit comment). */
export interface TrustVerdict {
  executable: boolean;
  reason?: string;
  /** DERIVED (issue #2603): the refusal is an `origin:external` HOLD, not a plain
   * trust-gate rejection. The claim path parks such an issue as `ready-for-human`
   * (awaiting a maintainer `/approve-external`) instead of merely un-claiming it. */
  holdForApproval?: boolean;
  /** Callable cure composed from the same data as {@link reason}. */
  repair?: RepairAction | "none";
  /** Required explanation when {@link repair} is explicitly `none`. */
  repair_reason?: string;
}

/** Build every trust refusal through the one repair/prose composer. */
function trustRefusal(state: string, repair: RepairSource): TrustVerdict {
  const composed = composeRepair({ state, repair });
  return {
    executable: false,
    reason: composed.prose,
    repair: composed.repair,
    ...(composed.repair === "none"
      ? { repair_reason: composed.repair_reason }
      : {}),
  };
}

/** The external-origin state resolved at claim time (issue #2603). `external` is
 * whether the issue carries the `origin:external` label; `approved` is whether a
 * maintainer `/approve-external` marker was found AND its author resolved as a
 * repository maintainer through {@link resolveActorTrust}. Both booleans are
 * pre-resolved by the runtime, keeping this module IO-free and unit-testable. */
export interface ExternalOriginState {
  /** The issue carries the `origin:external` label. */
  external: boolean;
  /** A maintainer `/approve-external` marker was found and trust-resolved. */
  approved: boolean;
  /** The approving maintainer login, for the log line (present when approved). */
  approver?: string;
}

/**
 * The pure external-origin gate (issue #2603). An `origin:external` issue is
 * HELD (parked for human review) until a maintainer `/approve-external` marker
 * is present. Non-external issues, and approved external issues, pass through.
 * Runs INDEPENDENTLY of the trust posture — an unapproved external issue is held
 * even on a permissive private repo, even if somehow already `ready-for-agent`.
 */
export function evaluateExternalOriginGate(
  state: ExternalOriginState | undefined,
  issue?: number,
): TrustVerdict {
  if (!state?.external || state.approved) return { executable: true };
  return {
    ...trustRefusal(
      "origin:external issue lacks explicit maintainer approval",
      externalApprovalRepair(issue),
    ),
    holdForApproval: true,
  };
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
 * Read the trust policy from the loaded config map, folding in the repository
 * `visibility` so the no-allowlist default becomes visibility-aware (issue #1101):
 *   - allowlist present            → `enabled:true` (strict, either visibility);
 *   - no allowlist + PUBLIC repo   → `failClosed:true` (untrusted work is held);
 *   - no allowlist + private/other → permissive (today's behaviour, preserved).
 * `visibility` is optional — an absent/undeterminable value keeps the permissive
 * default, so legacy callers that pass no visibility behave exactly as before.
 */
export function parseTrustPolicy(values: ConfigValues, visibility?: RepoVisibility): TrustPolicy {
  const allowlist = parseLogins(getConfig(values, TRUST_ALLOWLIST_KEY));
  const enabled = allowlist.length > 0;
  return { enabled, allowlist, visibility, failClosed: !enabled && visibility === "public" };
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
    return trustRefusal(
      `untrusted author ${author ? `'${author}'` : "(unknown)"} — not in the trust-gate allowlist`,
      noRepair("a maintainer must change the trust policy or submit the work through a trusted identity"),
    );
  }
  if (!actor || !allow.has(actor)) {
    return trustRefusal(
      `ready-for-agent applied by ${actor ? `'${actor}'` : "an unknown actor"} — not in the trust-gate allowlist`,
      noRepair("a trusted maintainer must apply ready-for-agent"),
    );
  }
  return { executable: true };
}

// ---------- actor-trust resolver (PRD #745, issue #747) ----------
//
// A LAYERED trust resolver over a single actor login, reused by two callers:
// comment-command authorization and issue-author auto-triage gating. Where the
// `evaluateTrustGate` predicate above is purely allowlist-driven, this resolver
// makes the allowlist an OVERRIDE on top of a DYNAMIC base — GitHub write-access
// or CODEOWNERS membership resolved through the `gh` runtime:
//
//   trust = (has write access OR is in CODEOWNERS) OR (in the allowlist override)
//
// The module stays IO-free: the gh-backed signal resolution is injected as an
// `ActorTrustLookup`, so the resolver only DECIDES. Refusal reuses the same
// `TrustVerdict` shape the gate already ships, with a human-readable reason.

/** The dynamic-base signals resolved from the `gh` runtime for one actor on the
 * repo. Each field is `undefined` when its gh read could not determine the
 * signal (gh absent, unauthenticated, network blip, 404) — the resolver treats
 * an undefined signal as "not available" rather than a definite `false`, which
 * is what preserves the permissive default. */
export interface ActorTrustSignals {
  /** True when the actor has push (write) access or higher to the repo. */
  hasWriteAccess?: boolean;
  /** True when the actor appears as an owner in the repo's CODEOWNERS file. */
  inCodeowners?: boolean;
}

/** The injected, gh-backed resolution of an actor's dynamic-base signals. The
 * production implementation lives in runtime/gh.ts; tests inject a fake. */
export type ActorTrustLookup = (actor: string) => Promise<ActorTrustSignals>;

/** The layer that granted (or, on refusal, failed to grant) trust — surfaced on
 * the verdict for the log line. */
export type ActorTrustBasis = "write-access" | "codeowners" | "allowlist" | "permissive-default";

/** The actor-trust verdict: the gate's {@link TrustVerdict} shape (so refusal
 * flows through the existing path) plus the deciding {@link ActorTrustBasis}. */
export interface ActorTrustVerdict extends TrustVerdict {
  basis?: ActorTrustBasis;
}

/**
 * Resolve whether `actor` is trusted on the repo. The SINGLE entry point reused
 * by comment-author authz and issue-author gating.
 *
 * Precedence:
 *   1. allowlist OVERRIDE — an allowlisted login is trusted even when gh cannot
 *      resolve its access (so the existing config keeps working offline);
 *   2. dynamic BASE — write access or CODEOWNERS membership (via `lookup`);
 *   3. PERMISSIVE default — when NEITHER a base signal NOR an allowlist is
 *      available/configured, trust everything (today's single-maintainer
 *      behaviour, preserved EXACTLY);
 *   4. otherwise REFUSE through the gate's `{ executable:false, reason }` shape.
 */
export async function resolveActorTrust(
  policy: TrustPolicy,
  actor: string | undefined,
  lookup: ActorTrustLookup,
): Promise<ActorTrustVerdict> {
  const login = (actor ?? "").trim();
  const allow = new Set(policy.allowlist);

  // 1. allowlist override — highest precedence, no gh read required.
  if (login && allow.has(login)) return { executable: true, basis: "allowlist" };

  // 2. dynamic base — write access / CODEOWNERS membership through gh.
  const signals = login ? await lookup(login) : {};
  if (signals.hasWriteAccess) return { executable: true, basis: "write-access" };
  if (signals.inCodeowners) return { executable: true, basis: "codeowners" };

  // 3. permissive default — neither a determinable base signal nor an allowlist.
  // SUPPRESSED under a fail-closed policy (public repo, no allowlist, issue #1101):
  // there the absence of a positive maintainer signal must HOLD, not wave through.
  const baseAvailable =
    signals.hasWriteAccess !== undefined || signals.inCodeowners !== undefined;
  if (!baseAvailable && !policy.enabled && !policy.failClosed) {
    return { executable: true, basis: "permissive-default" };
  }

  // 4. refuse via the existing trust-gate refusal shape.
  return trustRefusal(
      `${login ? `actor '${login}'` : "actor (unknown)"} is not a repository maintainer — ` +
      `no write access, not in CODEOWNERS, and not in the trust-gate allowlist`,
    noRepair("a maintainer must grant trust through repository access, CODEOWNERS, or the allowlist"),
  );
}

/**
 * The claim-time trust decision over BOTH provenance signals, dispatched by the
 * active {@link TrustPosture}:
 *   - `strict`      → the allowlist gate (`evaluateTrustGate`): author AND promoter
 *                     must be allowlisted.
 *   - `permissive`  → today's no-op: executable for everything.
 *   - `fail-closed` → (public repo, no allowlist, issue #1101) BOTH the author and
 *                     the `ready-for-agent` promoter must resolve as maintainers
 *                     via `resolveActorTrust` (write-access / CODEOWNERS / allowlist).
 *                     The author is checked first; either untrusted → HOLD.
 * `lookup` is only consulted on the fail-closed path; the strict/permissive paths
 * never touch gh, so a caller with no `ActorTrustLookup` can pass a stub.
 *
 * `external` (issue #2603) layers the {@link evaluateExternalOriginGate} on top:
 * an UNAPPROVED `origin:external` issue is HELD first, before any posture check.
 * An APPROVED external issue vouches for its (untrusted) author on the fail-closed
 * path — the maintainer `/approve-external` stands in for author trust — while the
 * `ready-for-agent` promoter is still required to be a maintainer.
 */
export async function evaluateClaimTrust(
  policy: TrustPolicy,
  provenance: TrustProvenance,
  lookup: ActorTrustLookup,
  external?: ExternalOriginState,
  issue?: number,
): Promise<TrustVerdict> {
  const externalVerdict = evaluateExternalOriginGate(external, issue);
  if (!externalVerdict.executable) return externalVerdict;

  if (policy.enabled) return evaluateTrustGate(policy, provenance);
  if (!policy.failClosed) return { executable: true };

  const authorVouched = external?.external === true && external.approved === true;
  if (!authorVouched) {
    const author = await resolveActorTrust(policy, provenance.author, lookup);
    if (!author.executable) {
      return trustRefusal(
        `untrusted author ${provenance.author ? `'${provenance.author}'` : "(unknown)"} did not resolve as a repository maintainer`,
        externalApprovalRepair(issue),
      );
    }
  }
  const actor = await resolveActorTrust(policy, provenance.readyForAgentActor, lookup);
  if (!actor.executable) {
    return trustRefusal(
      `untrusted ready-for-agent promoter ${provenance.readyForAgentActor ? `'${provenance.readyForAgentActor}'` : "(unknown)"} did not resolve as a repository maintainer`,
      externalApprovalRepair(issue),
    );
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
