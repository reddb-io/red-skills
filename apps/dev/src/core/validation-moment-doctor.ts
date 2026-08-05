export type ValidationMomentDriftKind =
  | "unsupported-declaration"
  | "declaration-not-wired"
  | "engine-not-declarable";

export interface ValidationMomentDriftFinding {
  readonly kind: ValidationMomentDriftKind;
  readonly moment: string;
  readonly reason: string;
  readonly remediation: string;
}

export interface ValidationMomentDriftReport {
  readonly verdict: "ok" | "drift";
  readonly findings: readonly ValidationMomentDriftFinding[];
}

export interface ValidationMomentDriftFacts {
  /** Moment keys actually present under afk.validation in this project. */
  readonly configuredMoments: readonly string[];
  /** Moment names the config declaration parser recognizes. */
  readonly declarationMoments: readonly string[];
  /** Moment names the lifecycle engine consumes. */
  readonly engineMoments: readonly string[];
}

/** Compare the project declaration, parser surface, and lifecycle registry. PURE. */
export function auditValidationMomentDrift(
  facts: ValidationMomentDriftFacts,
): ValidationMomentDriftReport {
  const configured = new Set(facts.configuredMoments);
  const declarable = new Set(facts.declarationMoments);
  const engine = new Set(facts.engineMoments);
  const findings: ValidationMomentDriftFinding[] = [];
  const supported = facts.engineMoments.join(", ").replace(/, ([^,]+)$/, ", or $1");

  for (const moment of [...configured].sort()) {
    if (engine.has(moment)) continue;
    findings.push({
      kind: "unsupported-declaration",
      moment,
      reason: `afk.validation.${moment} is declared but the engine has no such Validation moment`,
      remediation: `remove or rename the declaration to ${supported}`,
    });
  }
  for (const moment of [...declarable].sort()) {
    if (engine.has(moment)) continue;
    findings.push({
      kind: "declaration-not-wired",
      moment,
      reason: `afk.validation.${moment} is accepted by config but absent from the engine registry`,
      remediation: "wire the declaration into the lifecycle engine or remove it from the config surface",
    });
  }
  for (const moment of [...engine].sort()) {
    if (declarable.has(moment)) continue;
    findings.push({
      kind: "engine-not-declarable",
      moment,
      reason: `${moment} runs in the engine but cannot be declared under afk.validation`,
      remediation: "add the moment to the config declaration surface or remove it from the engine registry",
    });
  }

  return { verdict: findings.length === 0 ? "ok" : "drift", findings };
}
