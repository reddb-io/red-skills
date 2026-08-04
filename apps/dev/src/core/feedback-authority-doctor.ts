/**
 * `/red-doctor` safety check for operator-owned feedback commands (#3276).
 *
 * Replacing the discovered local suite is sound only when the repository's CI
 * still carries a required `test` verdict. The classifier is pure: config and
 * branch-protection facts are injected by the runtime collector.
 */

export type FeedbackAuthorityVerdict = "ok" | "warn" | "skip";

export interface FeedbackAuthorityFinding {
  readonly kind: "narrowed-feedback-without-required-test" | "required-checks-unavailable";
  readonly verdict: "warn";
  readonly reason: string;
  readonly remediation: string;
}

export interface FeedbackAuthorityReport {
  readonly declared: boolean;
  readonly commands: readonly string[];
  readonly requiredChecks: readonly string[] | null;
  readonly verdict: FeedbackAuthorityVerdict;
  readonly findings: readonly FeedbackAuthorityFinding[];
}

function isTestCheck(name: string): boolean {
  return /(^|[\s/:_-])test($|[\s/:_(-])/i.test(name.trim());
}

export function auditFeedbackAuthority(input: {
  commands: readonly string[] | undefined;
  requiredChecks: readonly string[] | null;
}): FeedbackAuthorityReport {
  if (input.commands === undefined) {
    return {
      declared: false,
      commands: [],
      requiredChecks: input.requiredChecks,
      verdict: "skip",
      findings: [],
    };
  }

  const commands = input.commands.map((command) => command.trim()).filter(Boolean);
  if (input.requiredChecks === null) {
    return {
      declared: true,
      commands,
      requiredChecks: null,
      verdict: "warn",
      findings: [{
        kind: "required-checks-unavailable",
        verdict: "warn",
        reason: "feedback.commands replaces the discovered local suite, but required CI checks could not be read",
        remediation: "require a CI test check on the Trunk, then re-run /red-doctor",
      }],
    };
  }

  if (input.requiredChecks.some(isTestCheck)) {
    return {
      declared: true,
      commands,
      requiredChecks: [...input.requiredChecks],
      verdict: "ok",
      findings: [],
    };
  }

  return {
    declared: true,
    commands,
    requiredChecks: [...input.requiredChecks],
    verdict: "warn",
    findings: [{
      kind: "narrowed-feedback-without-required-test",
      verdict: "warn",
      reason: "feedback.commands replaces the discovered local suite, but branch protection has no required test check",
      remediation: "make the merge queue's test check required, or restore the discovered local feedback harness",
    }],
  };
}
