/**
 * provider-block.ts — the opencode-native `provider>` block.
 *
 * Slice 1 of the opencode-host adapter (ADR 0075). The single source of
 * truth for the shape of `opencode.json` `provider.<id>` entries. Anything
 * opencode-shape-specific in this app lives here and nowhere else.
 *
 * What this file owns:
 *   - the list of providers the generator emits (OpenRouter, MiniMax, OpenAI
 *     today; add a new one by appending to {@link PROVIDER_ENTRIES} and, if
 *     it should win under env precedence, to {@link ENV_PRECEDENCE} below);
 *   - the {@link pickAuthPrecedence} function that re-applies the ADR 0059
 *     Amendment 1 env-precedence rule at build time to decide which entry is
 *     the "active" one in the emitted `opencode.json` `model` field;
 *   - the {@link buildProviderBlock} function that produces the
 *     `opencode.json` payload (a {@link OpencodeConfig}) from the precedence
 *     pick and the per-tier model table read from `.red/config.yaml`.
 *
 * What this file does NOT do:
 *   - write the API key into the emitted file. Auth stays in opencode's own
 *     `~/.local/share/opencode/auth.json` and the process env (ADR 0075 §3).
 *   - bundle. The generator is a build-time tool, not a runtime. The
 *     `bundle` script in `package.json` produces a release-asset form for
 *     the GHA lane (ADR 0038) but the local-dev path is `tsx generate.ts`.
 */
import { flatConfigValue, pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";

/** A single `provider.<id>` entry in the emitted `opencode.json`. */
export interface ProviderEntry {
  /** AI-SDK package opencode uses for this provider. */
  npm: string;
  /** Display name in the opencode `/models` picker. */
  name: string;
  /** Per-provider options (e.g. `baseURL` for OpenAI-compatible endpoints). */
  options?: { baseURL?: string; [k: string]: unknown };
}

/**
 * The providers RedSkills ships in Slice 1. The first segment of the model
 * slug `<provider>/<model>` is the key (e.g. `openrouter`, `minimax`,
 * `openai`); opencode dispatches on it. Order here is the **registration
 * order** in the emitted file, NOT the env-precedence order — precedence
 * lives in {@link ENV_PRECEDENCE} and is set by ADR 0059 Amendment 1.
 *
 * Add a new endpoint: append an entry here, and if it should win under the
 * first-set env-var rule, also add a slot to {@link ENV_PRECEDENCE} (an ADR
 * amendment to 0059 may be required if it changes the documented order).
 */
export const PROVIDER_ENTRIES: Readonly<Record<string, ProviderEntry>> = Object.freeze({
  openrouter: { npm: "@openrouter/ai-sdk-provider", name: "OpenRouter" },
  minimax: {
    npm: "@ai-sdk/openai-compatible",
    name: "MiniMax",
    options: { baseURL: "https://api.minimax.chat/v1" },
  },
  openai: { npm: "@ai-sdk/openai", name: "OpenAI" },
});

/**
 * Auth env-var precedence, in the documented order. The first env-var that
 * is set in the process wins; the corresponding provider becomes the
 * "active" one in the emitted `model` field.
 *
 * Back-compat: when only `OPENROUTER_API_KEY` is set, behaviour is
 * byte-for-byte identical to the pre-0075 AFK-only path (ADR 0059 §1
 * Amendment 1).
 *
 * Changing the order, adding a new slot, or removing an existing one is an
 * **ADR amendment to 0059** (it changes the documented auth surface), not
 * a code-only change. The current order is locked.
 */
export const ENV_PRECEDENCE: ReadonlyArray<{ env: string; provider: string }> =
  Object.freeze([
    { env: "OPENAI_API_KEY", provider: "openai" },
    { env: "MINIMAX_API_KEY", provider: "minimax" },
    { env: "OPENROUTER_API_KEY", provider: "openrouter" },
  ]);

/** The shape of the emitted `opencode.json` (Slice 1 — provider only). */
export interface OpencodeConfig {
  $schema: string;
  provider: Record<string, ProviderEntry>;
  model: string;
}

/** Resolved inputs to {@link buildProviderBlock}. */
export interface BuildInputs {
  /** Text of `.red/config.yaml`. Read-only; the function does not mutate. */
  configText: string;
  /** Process env. Read-only. The function does not read `process.env` itself. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Optional override for the slug written to `opencode.json.model`. If
   * `undefined`, the generator reads
   * `plugins.dev.afk.models.opencode.think.model` from the config (and falls
   * back to the OpenRouter-shaped default).
   */
  modelOverride?: string;
}

/**
 * Apply the ADR 0059 Amendment 1 env-precedence rule at build time. Returns
 * the provider key whose env-var is set, in the documented order. If none is
 * set, returns `undefined` (caller must fail closed per ADR 0075 §2).
 */
export function pickAuthPrecedence(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const slot of ENV_PRECEDENCE) {
    const value = env[slot.env];
    if (typeof value === "string" && value.length > 0) return slot.provider;
  }
  return undefined;
}

/**
 * Read the per-tier model table for the opencode runner from the constrained
 * `.red/config.yaml` grammar. Returns `undefined` when the block is absent or
 * the value is non-scalar — the caller falls back to the OpenRouter-shaped
 * default for back-compat with the AFK-only era.
 */
export function readOpencodeModelFromConfig(
  configText: string,
  tier: "think" | "complex" | "simple" | "validate" = "think",
): string | undefined {
  const value = flatConfigValue(configText, `plugins.dev.afk.models.opencode.${tier}.model`);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Strict opt-in gate: refuse to emit anything when the `dev` plugin is not
 * explicitly enabled (ADR 0067). The generator is fail-closed; this is the
 * one place that decides "is the project opted in at all".
 */
export function isDevPluginEnabled(configText: string): boolean {
  return pluginEnabledInConfig(configText, "dev");
}

/** The OpenRouter-shaped default for the `think` tier. */
export const DEFAULT_MODEL_SLUG = "openrouter/anthropic/claude-3.5-sonnet";

/**
 * Build the Slice 1 `opencode.json` payload. The function is pure: same
 * inputs always produce the same output, and it does not read from
 * `process.env` or the filesystem (caller injects both).
 *
 * The active provider is chosen by {@link pickAuthPrecedence}; the model
 * slug is the explicit override (if given), then the per-tier config value
 * (defaulting to `think`), then the OpenRouter-shaped default. The
 * precedence pick and the model slug are independent: a user can have
 * `MINIMAX_API_KEY` set (so the `minimax` provider is the active one) and
 * still write `plugins.dev.afk.models.opencode.think.model:
 * minimax/MiniMax-M3`; the function does not second-guess.
 */
export function buildProviderBlock(inputs: BuildInputs): OpencodeConfig {
  const active = pickAuthPrecedence(inputs.env) ?? "openrouter";
  const fromConfig = inputs.modelOverride ?? readOpencodeModelFromConfig(inputs.configText);
  const model = fromConfig ?? DEFAULT_MODEL_SLUG;

  const provider: Record<string, ProviderEntry> = {};
  for (const [id, entry] of Object.entries(PROVIDER_ENTRIES)) {
    provider[id] = entry;
  }
  // Re-order so the active provider is first in the emitted file. The keys
  // themselves are unchanged; opencode does not care about order, but a
  // developer reading the file benefits from "the one that will actually be
  // used is at the top".
  const ordered: Record<string, ProviderEntry> = {};
  ordered[active] = provider[active]!;
  for (const [id, entry] of Object.entries(provider)) {
    if (id === active) continue;
    ordered[id] = entry;
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: ordered,
    model,
  };
}
