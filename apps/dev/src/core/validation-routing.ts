import type { AgentEffort } from "./execution.js";
import type { AfkModelTier, ResolvedTier } from "./config.js";
import type { Runner } from "../types/runner.js";

export type ValidationVerdictStatus = "passed" | "failed";

export interface ValidationVerdict {
  status: ValidationVerdictStatus;
  summary: string;
  details?: string;
}

export type StructuralValidationKind =
  | "json-parse"
  | "yaml-parse"
  | "schema"
  | "jq"
  | "yamllint"
  | "key-presence"
  | "grep";

export type FuzzyValidationKind = "semantic-intent" | "content-intent";

export interface StructuralValidationCheck {
  mode: "structural";
  name: string;
  kind: StructuralValidationKind;
  run: () => ValidationVerdict | Promise<ValidationVerdict>;
}

export interface FuzzyValidationCheck {
  mode: "fuzzy";
  name: string;
  kind: FuzzyValidationKind;
  prompt: string;
}

export type ValidationCheck = StructuralValidationCheck | FuzzyValidationCheck;

export type ValidationRoute =
  | { execution: "deterministic"; modelCalls: 0 }
  | { execution: "model"; tier: "validate"; modelCalls: 1 };

export interface RoutedValidationResult {
  check: string;
  route: ValidationRoute;
  verdict: ValidationVerdict;
}

export type ResolveValidationTier = (runner: Runner, taskClass: AfkModelTier) => ResolvedTier;

export interface ValidateTierDispatchInput {
  runner: Runner;
  tier: "validate";
  model: string;
  effort: AgentEffort;
  check: FuzzyValidationCheck;
}

export type ValidateTierDispatch = (input: ValidateTierDispatchInput) => Promise<ValidationVerdict>;

export interface RunValidationCheckDeps {
  runner: Runner;
  resolveTier: ResolveValidationTier;
  dispatchValidate: ValidateTierDispatch;
}

export function validationRouteFor(check: ValidationCheck): ValidationRoute {
  if (check.mode === "structural") return { execution: "deterministic", modelCalls: 0 };
  return { execution: "model", tier: "validate", modelCalls: 1 };
}

export async function runValidationCheck(
  check: ValidationCheck,
  deps: RunValidationCheckDeps,
): Promise<RoutedValidationResult> {
  const route = validationRouteFor(check);

  if (check.mode === "structural") {
    return {
      check: check.name,
      route,
      verdict: await check.run(),
    };
  }

  const tier = deps.resolveTier(deps.runner, "validate");
  return {
    check: check.name,
    route,
    verdict: await deps.dispatchValidate({
      runner: deps.runner,
      tier: "validate",
      model: tier.model,
      effort: tier.effort,
      check,
    }),
  };
}
