import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";

export const MODEL_TIER_BANDIT_SCHEMA_VERSION = 1 as const;

export const MODEL_TIER_BANDIT_TIERS = ["validate", "simple", "complex", "think"] as const;
export type ModelTierBanditTier = (typeof MODEL_TIER_BANDIT_TIERS)[number];

export interface ModelTierPosterior {
  alpha: number;
  beta: number;
}

export interface ModelTierBanditArmState {
  posterior: ModelTierPosterior;
  observations: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
}

export interface ModelTierBanditBucketState {
  arms: Record<ModelTierBanditTier, ModelTierBanditArmState>;
}

export interface ModelTierBanditDocument {
  schemaVersion: typeof MODEL_TIER_BANDIT_SCHEMA_VERSION;
  buckets: Record<string, ModelTierBanditBucketState>;
}

export interface ModelTierPosteriorStats extends ModelTierPosterior {
  tier: ModelTierBanditTier;
  mean: number;
  observations: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  sample: number;
}

export interface ModelTierEscalationBreaker {
  fromTier: ModelTierBanditTier;
  toTier: ModelTierBanditTier;
  consecutiveFailures: number;
}

export interface ModelTierBanditAdvice {
  source: "brain.model-tier-bandit";
  taskClass: string;
  recommendedTier: ModelTierBanditTier;
  confidence: number;
  posterior: ModelTierPosteriorStats[];
  explanation: string;
  breaker?: ModelTierEscalationBreaker;
}

export interface ReplayModelTierBanditOptions {
  initial?: ModelTierBanditDocument;
  tierForEvent?: (event: OutcomeEvent) => ModelTierBanditTier | undefined;
}

export interface RecommendModelTierOptions {
  samplePosterior?: (stats: Omit<ModelTierPosteriorStats, "sample">) => number;
  failureEscalationThreshold?: number;
}

const PRIOR_ALPHA = 1;
const PRIOR_BETA = 1;
const FAILURE_ESCALATION_THRESHOLD = 2;

const SUCCESS_REWARD: Record<ModelTierBanditTier, number> = {
  validate: 1,
  simple: 0.85,
  complex: 0.65,
  think: 0.45,
};

export function createModelTierBanditDocument(): ModelTierBanditDocument {
  return { schemaVersion: MODEL_TIER_BANDIT_SCHEMA_VERSION, buckets: {} };
}

export function replayModelTierBandit(
  events: readonly OutcomeEvent[],
  options: ReplayModelTierBanditOptions = {},
): ModelTierBanditDocument {
  const document = cloneDocument(options.initial ?? createModelTierBanditDocument());
  for (const event of events) applyModelTierOutcome(document, event, options);
  return document;
}

export function applyModelTierOutcome(
  document: ModelTierBanditDocument,
  event: OutcomeEvent,
  options: ReplayModelTierBanditOptions = {},
): ModelTierBanditDocument {
  const tier = (options.tierForEvent ?? tierFromOutcomeEvent)(event);
  if (!tier) return document;

  const bucket = bucketFor(document, event.taskClass);
  const arm = bucket.arms[tier];
  const reward = rewardFor(event, tier);
  arm.posterior.alpha = round(arm.posterior.alpha + reward);
  arm.posterior.beta = round(arm.posterior.beta + (1 - reward));
  arm.observations += 1;
  if (event.outcome === "success") {
    arm.successes += 1;
    arm.consecutiveFailures = 0;
  } else {
    arm.failures += 1;
    arm.consecutiveFailures += 1;
  }
  return document;
}

export function recommendModelTier(
  document: ModelTierBanditDocument,
  taskClass: string,
  options: RecommendModelTierOptions = {},
): ModelTierBanditAdvice {
  const bucket = document.buckets[taskClass] ?? emptyBucket();
  const samplePosterior =
    options.samplePosterior ?? ((stats: Omit<ModelTierPosteriorStats, "sample">) => sampleBeta(stats.alpha, stats.beta));
  const posterior = MODEL_TIER_BANDIT_TIERS.map((tier): ModelTierPosteriorStats => {
    const arm = bucket.arms[tier];
    const base = {
      tier,
      alpha: arm.posterior.alpha,
      beta: arm.posterior.beta,
      mean: posteriorMean(arm.posterior),
      observations: arm.observations,
      successes: arm.successes,
      failures: arm.failures,
      consecutiveFailures: arm.consecutiveFailures,
    };
    return { ...base, sample: round(samplePosterior(base)) };
  }).sort((a, b) => b.sample - a.sample || b.mean - a.mean || tierRank(a.tier) - tierRank(b.tier));

  const sampledWinner = posterior[0] ?? statsForEmptyTier("validate");
  const breaker = escalationBreakerFor(sampledWinner, options.failureEscalationThreshold ?? FAILURE_ESCALATION_THRESHOLD);
  const recommendedTier = breaker?.toTier ?? sampledWinner.tier;
  const runnerUp = posterior.find((stats) => stats.tier !== sampledWinner.tier);
  const confidence = round(Math.max(0, sampledWinner.mean - (runnerUp?.mean ?? 0)));

  return {
    source: "brain.model-tier-bandit",
    taskClass,
    recommendedTier,
    confidence,
    posterior,
    explanation: renderExplanation(taskClass, sampledWinner, recommendedTier, confidence, breaker),
    ...(breaker ? { breaker } : {}),
  };
}

export function tierFromOutcomeEvent(event: OutcomeEvent): ModelTierBanditTier | undefined {
  const kind = event.chosenOption.kind;
  if (isModelTier(kind)) return kind;
  const model = event.chosenOption.model?.toLowerCase() ?? "";
  const effort = event.chosenOption.effort?.toLowerCase() ?? "";
  if (model.includes("haiku")) return "validate";
  if (model.includes("sonnet")) return "simple";
  if (model.includes("opus") && effort === "high") return "think";
  if (model.includes("opus")) return "complex";
  return undefined;
}

function rewardFor(event: OutcomeEvent, tier: ModelTierBanditTier): number {
  if (event.outcome !== "success") return 0;
  return SUCCESS_REWARD[tier];
}

function escalationBreakerFor(
  winner: ModelTierPosteriorStats,
  threshold: number,
): ModelTierEscalationBreaker | undefined {
  if (winner.consecutiveFailures < threshold) return undefined;
  const fromIdx = MODEL_TIER_BANDIT_TIERS.indexOf(winner.tier);
  const toTier = MODEL_TIER_BANDIT_TIERS[Math.min(fromIdx + 1, MODEL_TIER_BANDIT_TIERS.length - 1)]!;
  if (toTier === winner.tier) return undefined;
  return { fromTier: winner.tier, toTier, consecutiveFailures: winner.consecutiveFailures };
}

function renderExplanation(
  taskClass: string,
  winner: ModelTierPosteriorStats,
  recommendedTier: ModelTierBanditTier,
  confidence: number,
  breaker: ModelTierEscalationBreaker | undefined,
): string {
  const base =
    `brain bandit advice for '${taskClass}': ${winner.tier} has posterior ` +
    `alpha=${winner.alpha}, beta=${winner.beta}, mean=${winner.mean}`;
  const suffix = `confidence=${confidence}`;
  if (!breaker) return `${base}; recommended ${recommendedTier}; ${suffix}.`;
  return (
    `${base}, but ${winner.tier} has ${breaker.consecutiveFailures} consecutive failures; ` +
    `escalation breaker recommends ${recommendedTier}; ${suffix}.`
  );
}

function bucketFor(document: ModelTierBanditDocument, taskClass: string): ModelTierBanditBucketState {
  const key = taskClass.trim() || "unknown";
  document.buckets[key] ??= emptyBucket();
  return document.buckets[key]!;
}

function emptyBucket(): ModelTierBanditBucketState {
  return {
    arms: {
      validate: emptyArm(),
      simple: emptyArm(),
      complex: emptyArm(),
      think: emptyArm(),
    },
  };
}

function emptyArm(): ModelTierBanditArmState {
  return {
    posterior: { alpha: PRIOR_ALPHA, beta: PRIOR_BETA },
    observations: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
  };
}

function statsForEmptyTier(tier: ModelTierBanditTier): ModelTierPosteriorStats {
  const arm = emptyArm();
  return {
    tier,
    alpha: arm.posterior.alpha,
    beta: arm.posterior.beta,
    mean: posteriorMean(arm.posterior),
    observations: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    sample: 0.5,
  };
}

function cloneDocument(document: ModelTierBanditDocument): ModelTierBanditDocument {
  return JSON.parse(JSON.stringify(document)) as ModelTierBanditDocument;
}

function isModelTier(value: string): value is ModelTierBanditTier {
  return (MODEL_TIER_BANDIT_TIERS as readonly string[]).includes(value);
}

function posteriorMean(posterior: ModelTierPosterior): number {
  return round(posterior.alpha / (posterior.alpha + posterior.beta));
}

function tierRank(tier: ModelTierBanditTier): number {
  return MODEL_TIER_BANDIT_TIERS.indexOf(tier);
}

function sampleBeta(alpha: number, beta: number, rng = Math.random): number {
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  return x + y === 0 ? 0 : x / (x + y);
}

function sampleGamma(shape: number, rng: () => number): number {
  if (shape <= 0) return 0;
  if (shape < 1) {
    return sampleGamma(shape + 1, rng) * Math.pow(Math.max(rng(), Number.MIN_VALUE), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = Math.pow(1 + c * x, 3);
    if (v <= 0) continue;
    const u = rng();
    if (u < 1 - 0.0331 * Math.pow(x, 4)) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function normal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
