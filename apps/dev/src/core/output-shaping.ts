import type { ConfigValues } from "./config.js";
import { getConfig } from "./config.js";

export type OutputShapingVariant = "steered" | "holdout";

export interface OutputShapingConfig {
  terseSteering: boolean;
}

export interface OutputShapingAssignment {
  enabled: boolean;
  variant: OutputShapingVariant;
}

export function resolveOutputShapingConfig(config: ConfigValues): OutputShapingConfig {
  return {
    terseSteering: getConfig(config, "afk.output_shaping.terse_steering") === "true",
  };
}

export function assignOutputShaping(issue: number, config: OutputShapingConfig): OutputShapingAssignment {
  return {
    enabled: config.terseSteering,
    variant: issue % 2 === 0 ? "steered" : "holdout",
  };
}

export function renderTerseSteeringBlock(assignment: OutputShapingAssignment): string {
  if (!assignment.enabled || assignment.variant !== "steered") return "";
  return [
    "Phrasing-only steering for this holdout arm:",
    "- Keep prose terse and factual.",
    "- Do not restate the issue, handoff, or plan unless it changes a concrete action.",
    "- Avoid ceremonial summaries and progress narration that does not affect the work.",
    "- Preserve every task requirement and validation contract exactly.",
  ].join("\n");
}
