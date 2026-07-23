// deadend-heal.ts — gated per-class mechanical healing over sanctioned cores (#2429).
//
// The HEALABLE_CLASSES closed set names every deadend class that has a mechanical
// cure path through one of three sanctioned mutation cores: hitl_resolve, requeue,
// and concede. Nothing mutates until the repo config's allowlist opts a class in
// (default-empty). Non-mechanical classes are excluded from HEALABLE_CLASSES and
// can never be healed regardless of config.
//
// Each class's cure is pinned to exactly one core call sequence:
//   dangling_claim        → concede(issue) then comment(issue, auditBody)
//   red_pr_dead_owner     → hitlResolve(ticket, "requeue", auditBody)
//   superseded_pr         → hitlResolve(prNumber, "close", auditBody)
//   active_current_blocker → hitlResolve(issue, "park", auditBody)
//   dependency_all_closed → requeue(issue, auditGuidance)

import type { DeadendClass, DeadendFinding } from "./deadend-audit.js";
import type { HitlDecision } from "./hitl-resolve.js";

/** Classes that can be mechanically healed via a sanctioned mutation core. */
export const HEALABLE_CLASSES = new Set<DeadendClass>([
  "dangling_claim",
  "red_pr_dead_owner",
  "superseded_pr",
  "active_current_blocker",
  "dependency_all_closed",
]);

export type HealableClass = Extract<
  DeadendClass,
  | "dangling_claim"
  | "red_pr_dead_owner"
  | "superseded_pr"
  | "active_current_blocker"
  | "dependency_all_closed"
>;

/** Returns true iff the class has a mechanical cure path through a sanctioned core. */
export function isHealable(cls: DeadendClass): cls is HealableClass {
  return HEALABLE_CLASSES.has(cls);
}

/** The per-class heal allowlist parsed from the repo config. */
export interface DeadendHealConfig {
  /** Empty set = no healing permitted. Entries are restricted to HEALABLE_CLASSES. */
  readonly allowedClasses: ReadonlySet<HealableClass>;
}

/** The default heal config: empty allowlist, zero mutations. */
export const EMPTY_HEAL_CONFIG: DeadendHealConfig = { allowedClasses: new Set() };

/** Thrown when an unknown class name appears in the config allowlist. */
export class UnknownHealClassError extends Error {
  constructor(name: string) {
    super(
      `unknown deadend heal class "${name}" — valid classes: ${[...HEALABLE_CLASSES].join(", ")}`,
    );
    this.name = "UnknownHealClassError";
  }
}

/**
 * Parse the comma-separated class allowlist from the config value.
 *
 * Config key: `afk.deadend.heal.allowed-classes` (default absent / empty).
 * Empty or whitespace-only value returns {@link EMPTY_HEAL_CONFIG}.
 * Any unrecognized name (including non-mechanical classes) throws
 * {@link UnknownHealClassError} immediately — unknown names are rejected at
 * load so the operator learns about the typo before the automation runs.
 */
export function parseDeadendHealConfig(value: string): DeadendHealConfig {
  const trimmed = value.trim();
  if (!trimmed) return EMPTY_HEAL_CONFIG;
  const allowed = new Set<HealableClass>();
  for (const raw of trimmed.split(",")) {
    const name = raw.trim() as DeadendClass;
    if (!HEALABLE_CLASSES.has(name)) throw new UnknownHealClassError(name);
    allowed.add(name as HealableClass);
  }
  return { allowedClasses: allowed };
}

/**
 * The three sanctioned mutation cores exposed to the heal module.
 * No direct GitHub mutation is permitted — every write goes through one of these.
 */
export interface DeadendHealDeps {
  /** hitl_resolve core: post rationale comment + label transition (+ optional close/claims). */
  hitlResolve(issue: number, decision: HitlDecision, rationale: string): Promise<void>;
  /** requeue core: apply the full parked-issue requeue transition with guidance. */
  requeue(issue: number, guidance: string): Promise<void>;
  /** concede core: release all dangling claim markers on the issue. */
  concede(issue: number): Promise<void>;
  /** Post an audit comment on the Ticket after a concede or requeue that has no built-in comment. */
  comment(issue: number, body: string): Promise<void>;
}

function healAuditBody(cls: DeadendClass, detail: string): string {
  return `🤖 deadend-heal: automated cure for **${cls}** — ${detail}`;
}

/**
 * Apply the mechanical heal for one finding, subject to the allowlist.
 *
 * Returns without side effects when:
 * - the class is not in HEALABLE_CLASSES (non-mechanical guard)
 * - the class is not in the allowlist (opt-in gate)
 * - the finding carries no healTarget (e.g. a red PR with no linked Ticket)
 *
 * Every successful heal posts an audit comment on the affected Ticket
 * (either via the sanctioned core's built-in comment or an explicit call).
 */
export async function healDeadendFinding(
  deps: DeadendHealDeps,
  finding: DeadendFinding,
  config: DeadendHealConfig,
): Promise<void> {
  // Non-mechanical guard: checked first so it holds even if allowedClasses is
  // constructed outside parseDeadendHealConfig (defence in depth).
  if (!isHealable(finding.deadendClass)) return;
  if (!config.allowedClasses.has(finding.deadendClass)) return;

  const target = finding.healTarget;
  if (target === undefined) return;

  const auditBody = healAuditBody(finding.deadendClass, finding.detail);

  switch (finding.deadendClass) {
    case "dangling_claim":
      // concede → comment (concede does not post its own audit comment)
      await deps.concede(target);
      await deps.comment(target, auditBody);
      break;

    case "red_pr_dead_owner":
      // hitl_resolve always posts the rationale as its own comment
      await deps.hitlResolve(target, "requeue", auditBody);
      break;

    case "superseded_pr":
      await deps.hitlResolve(target, "close", auditBody);
      break;

    case "active_current_blocker":
      // quarantine = park to ready-for-human
      await deps.hitlResolve(target, "park", auditBody);
      break;

    case "dependency_all_closed":
      // requeue core posts guidance as the audit trail
      await deps.requeue(target, auditBody);
      break;
  }
}
