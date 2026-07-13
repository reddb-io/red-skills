export const TOKEN_ESTIMATE_RANGE_PCT = 0.25;

export interface TokenSavingsEstimate {
  tokens_saved: number;
  tokens_saved_estimated: boolean;
  token_estimate_range_pct: number | null;
  tokens_saved_low: number | null;
  tokens_saved_high: number | null;
  dollars_saved_estimate_usd: number;
  dollars_saved_low_usd: number | null;
  dollars_saved_high_usd: number | null;
  pricing_model_family: string;
  pricing_input_usd_per_million_tokens: number;
  pricing_note: string;
}

export const DEFAULT_RSP_PRICING_MODEL_FAMILY = "gpt-5";

export const RSP_INPUT_TOKEN_PRICE_USD_PER_MILLION: Record<string, number> = {
  "gpt-5": 1.25,
  "gpt-5-mini": 0.25,
  "gpt-5-nano": 0.05,
  "gpt-4.1": 2,
  "gpt-4.1-mini": 0.4,
  "gpt-4o": 2.5,
  "gpt-4o-mini": 0.15,
};

const PRICING_NOTE = "estimate derived from byte-based token estimate when token counts are estimated";

export function tokenSavingsEstimate(
  tokensSaved: number,
  estimated: boolean,
  modelFamily = DEFAULT_RSP_PRICING_MODEL_FAMILY,
): TokenSavingsEstimate {
  const tokens = Math.max(0, Math.floor(tokensSaved));
  const normalizedModel = modelFamily in RSP_INPUT_TOKEN_PRICE_USD_PER_MILLION
    ? modelFamily
    : DEFAULT_RSP_PRICING_MODEL_FAMILY;
  const price = RSP_INPUT_TOKEN_PRICE_USD_PER_MILLION[normalizedModel]!;
  const low = estimated ? Math.floor(tokens * (1 - TOKEN_ESTIMATE_RANGE_PCT)) : null;
  const high = estimated ? Math.ceil(tokens * (1 + TOKEN_ESTIMATE_RANGE_PCT)) : null;
  return {
    tokens_saved: tokens,
    tokens_saved_estimated: estimated,
    token_estimate_range_pct: estimated ? TOKEN_ESTIMATE_RANGE_PCT : null,
    tokens_saved_low: low,
    tokens_saved_high: high,
    dollars_saved_estimate_usd: dollarsForTokens(tokens, price),
    dollars_saved_low_usd: low == null ? null : dollarsForTokens(low, price),
    dollars_saved_high_usd: high == null ? null : dollarsForTokens(high, price),
    pricing_model_family: normalizedModel,
    pricing_input_usd_per_million_tokens: price,
    pricing_note: PRICING_NOTE,
  };
}

export function dollarsForTokens(tokens: number, usdPerMillionTokens: number): number {
  return roundUsd((Math.max(0, tokens) / 1_000_000) * usdPerMillionTokens);
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
