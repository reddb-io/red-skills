// core/fork-ci-approve — PURE decision for auto-approving a fork PR's CI run.
//
// GitHub requires a maintainer to manually approve the FIRST CI run of a PR from
// a fork (the "approve and run" gate). The gate exists because a fork's workflow
// can otherwise exfiltrate `secrets.*` or abuse a write-scoped `GITHUB_TOKEN`.
// AFK should not wait on a human when the run is PROVABLY safe — but it must be
// provable, not merely plausible, so the bar is deliberately conservative:
//
//   provably safe  ⇔  the manifest references NO `secrets.*`
//                     AND every declared permission is read-only (or none)
//                     AND a `permissions:` block WAS declared (an undeclared
//                     block inherits GitHub's broad-write default — not provable).
//
// Anything short of that defers to a human. This module owns the DECISION only
// (no `gh`, no network): the caller projects the triggered workflow source(s)
// into a {@link ForkCiManifest} and executes the approval when the verdict is
// `auto-approve`. Keeping it pure makes the safety rule unit-testable with plain
// values — and additive: nothing auto-approves until a caller wires it in.

/** A permission access level as declared under a workflow/job `permissions:` map. */
export type PermissionLevel = "read" | "write" | "none";

/** The effective CI manifest for a fork PR run, projected from the workflow file(s). */
export interface ForkCiManifest {
  /**
   * Raw text of EVERY workflow job that would run for this PR event, concatenated
   * into one field. Scanned verbatim for `secrets.*` references, so pass the
   * literal workflow source (not a parsed projection that could drop a ref).
   */
  raw: string;
  /**
   * The effective token permissions for the run: scope name → access level.
   * GitHub shorthands must be pre-expanded by the caller (`read-all` → every
   * scope `read`, `write-all` → every scope `write`, `{}` → every scope `none`).
   */
  permissions: Readonly<Record<string, PermissionLevel>>;
  /**
   * False when NO `permissions:` block was declared anywhere for the run. An
   * undeclared block inherits GitHub's default token scope (broad write for a
   * classic default), which is NOT provably read-only — so it defers.
   */
  permissionsDeclared: boolean;
}

export type ForkCiDecision = "auto-approve" | "defer-to-human";

export interface ForkCiVerdict {
  decision: ForkCiDecision;
  /** Every reason the run was not provably safe; empty on `auto-approve`. */
  reasons: string[];
}

/**
 * Matches any `secrets.*` reference: the dotted (`secrets.FOO`) and bracketed
 * (`secrets['FOO']` / `secrets["FOO"]`) index forms, with optional whitespace as
 * GitHub's expression parser tolerates. `secrets.GITHUB_TOKEN` is deliberately
 * INCLUDED — even though its power is bounded by `permissions:`, a provable
 * guarantee cannot depend on the human reading both blocks together.
 */
const SECRETS_REF_RE = /\bsecrets\s*[.[]/;

/**
 * Decide whether a fork PR's CI run is provably safe to auto-approve. PURE — the
 * caller performs the `gh` approval iff `decision === "auto-approve"`. Returns
 * every failing reason so a deferral can explain itself on the issue/PR.
 */
export function assessForkCiSafety(manifest: ForkCiManifest): ForkCiVerdict {
  const reasons: string[] = [];

  if (SECRETS_REF_RE.test(manifest.raw)) {
    reasons.push("workflow references secrets.* — a fork run must not access secrets");
  }

  if (!manifest.permissionsDeclared) {
    reasons.push(
      "no permissions: block declared — GitHub's default token scope is not provably read-only",
    );
  } else {
    const writes = Object.entries(manifest.permissions)
      .filter(([, level]) => level === "write")
      .map(([scope]) => scope)
      .sort();
    if (writes.length > 0) {
      reasons.push(
        `write-scoped permissions present (${writes.join(", ")}) — a fork run must be read-only`,
      );
    }
  }

  return { decision: reasons.length === 0 ? "auto-approve" : "defer-to-human", reasons };
}
