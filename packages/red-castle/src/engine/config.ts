import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StateTransitionLabels } from "./state-transition.js";

export type EngineConfigValues = Record<string, string>;
export type EngineConfigReader = (path: string) => string | undefined;
export type EngineConfigWarn = (message: string) => void;

export class MalformedEngineConfigError extends Error {
  constructor(message = "malformed YAML") {
    super(message);
    this.name = "MalformedEngineConfigError";
  }
}

export const ENGINE_CONFIG_DEFAULTS = {
  "afk.default_runner": "claude",
  "afk.sandbox": "none",
  "afk.max_iterations": "12",
  "afk.worktree_launches_pull_request": "true",
  "afk.claim_reaper.refresh_s": "300",
  "afk.claim_reaper.stale_tolerance": "3",
  "afk.claim_reaper.grace_s": "300",
  "afk.claim_reaper.recent_commit_s": "2700",
  "afk.validation.node_max_old_space_mb": "2048",
  "afk.validation.vitest_max_workers": "1",
  "afk.validation.heavy_available_memory_mb": "4096",
  "afk.labels.ready": "ready-for-agent",
  "afk.labels.running": "running",
  "afk.labels.human": "ready-for-human",
  "afk.labels.dependency_blocked": "blocked:dependency",
  "afk.labels.needs_triage": "needs-triage",
  "afk.labels.needs_info": "needs-info",
  "afk.labels.quarantine": "quarantine",
  "afk.labels.blocked_prefix": "blocked:",
  "afk.labels.req_prefix": "req:",
} as const;

const RED_AFK_ENV_ACCESSORS = {
  RED_AFK_RUNNER: "afk.default_runner",
  RED_AFK_SANDBOX: "afk.sandbox",
  RED_AFK_MAX_ITERATIONS: "afk.max_iterations",
  RED_AFK_CLAIM_REFRESH_S: "afk.claim_reaper.refresh_s",
  RED_AFK_CLAIM_STALE_TOLERANCE: "afk.claim_reaper.stale_tolerance",
  RED_AFK_CLAIM_REAPER_GRACE_S: "afk.claim_reaper.grace_s",
  RED_AFK_CLAIM_REAPER_RECENT_COMMIT_S: "afk.claim_reaper.recent_commit_s",
} as const;

const DELETED_CONFIG_KEYS = new Set([
  "afk.attempt_timeout",
  "plugins.dev.afk.attempt_timeout",
  // The statusline's local `gh` count cache is gone (ADR 0141 decision 2): every
  // remote counter is the daemon's, polled on its cycle. A TTL for a cache that
  // does not exist is accepted and dropped rather than warned about, so an
  // operator's older config still loads.
  "afk.statusline_cache_ttl",
  "plugins.dev.afk.statusline_cache_ttl",
]);

export interface LoadEngineConfigOptions {
  readonly read?: EngineConfigReader;
  readonly warn?: EngineConfigWarn;
  readonly env?: Record<string, string | undefined>;
}

export interface EngineConfig {
  readonly enabled: boolean;
  readonly redRoot: string;
  readonly configPath: string;
  readonly values: EngineConfigValues;
  readonly get: (key: string) => string;
}

/** The engine's label vocabulary. It satisfies {@link StateTransitionLabels},
 * so every castle writer hands the SAME injected config to `planTransition`
 * that it uses for its own reads (#2666). */
export interface EngineLabelVocabulary extends StateTransitionLabels {
  readonly ready: string;
  readonly running: string;
  readonly human: string;
  readonly needsTriage: string;
  readonly needsInfo: string;
  readonly quarantine: string;
  readonly dependencyBlocked: string;
  readonly blockedPrefix: string;
  readonly reqPrefix: string;
}

const defaultReader: EngineConfigReader = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const defaultWarn: EngineConfigWarn = (message) => {
  process.stderr.write(`${message}\n`);
};

function configDefaults(): EngineConfigValues {
  return { ...ENGINE_CONFIG_DEFAULTS };
}

function stripCommentOutsideQuotes(text: string): string {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === '"' || ch === "'") && (i === 0 || text[i - 1] !== "\\")) {
      quote = quote === ch ? undefined : (quote ?? ch);
      continue;
    }
    if (ch === "#" && quote === undefined) return text.slice(0, i);
  }
  return text;
}

function unquoteScalar(value: string): string {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2)
      throw new MalformedEngineConfigError();
    return value.slice(1, -1);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2)
      throw new MalformedEngineConfigError();
    return value.slice(1, -1);
  }
  return value;
}

export function parseEngineConfigYaml(text: string): EngineConfigValues {
  const out: EngineConfigValues = {};
  const stack: string[] = [];
  const indents: number[] = [];
  const seqCounters: Record<string, number> = {};

  for (let raw of text.split("\n")) {
    raw = raw.replace(/\r$/, "");
    const stripped = stripCommentOutsideQuotes(raw).replace(/\s+$/, "");
    if (stripped.trim() === "") continue;

    const indent = stripped.match(/^\s*/)?.[0].length ?? 0;
    if (indent % 2 !== 0) throw new MalformedEngineConfigError();

    let rest = stripped.slice(indent);
    while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
      stack.pop();
      indents.pop();
    }

    if (/^-(\s|$)/.test(rest)) {
      if (stack.length === 0) throw new MalformedEngineConfigError();
      rest = rest.slice(1).trimStart();
      if (rest === "") throw new MalformedEngineConfigError();

      const parent = stack.join(".");
      const idx = seqCounters[parent] ?? 0;
      seqCounters[parent] = idx + 1;
      out[`${parent}.${idx}`] = unquoteScalar(rest);
      continue;
    }

    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*:/.test(rest)) {
      throw new MalformedEngineConfigError();
    }

    const colon = rest.indexOf(":");
    const key = rest.slice(0, colon);
    const value = rest.slice(colon + 1).trimStart();
    const full = stack.length > 0 ? `${stack.join(".")}.${key}` : key;

    if (value === "") {
      stack.push(key);
      indents.push(indent);
    } else {
      out[full] = unquoteScalar(value);
    }
  }

  return out;
}

function foldDevNamespace(
  values: EngineConfigValues,
  parsed: EngineConfigValues,
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (DELETED_CONFIG_KEYS.has(key)) continue;
    values[key] = value;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (DELETED_CONFIG_KEYS.has(key)) continue;
    const match = /^plugins\.dev\.(.+)$/.exec(key);
    if (!match) continue;
    const rest = match[1]!;
    const accessor =
      rest === "afk" || rest.startsWith("afk.") ? rest : `dev.${rest}`;
    values[accessor] = value;
  }
}

function applyEnvOverrides(
  values: EngineConfigValues,
  env: Record<string, string | undefined>,
): void {
  for (const [envKey, accessor] of Object.entries(RED_AFK_ENV_ACCESSORS)) {
    const value = env[envKey];
    if (value !== undefined && value.trim() !== "") values[accessor] = value;
  }
}

export function pluginDevEnabled(values: EngineConfigValues): boolean {
  return values["plugins.dev.enabled"] === "true";
}

export function loadEngineConfig(
  redRoot: string,
  options: LoadEngineConfigOptions = {},
): EngineConfig {
  const root = resolve(redRoot);
  const configPath = resolve(root, "config.yaml");
  const read = options.read ?? defaultReader;
  const warn = options.warn ?? defaultWarn;
  const env = options.env ?? process.env;
  const values = configDefaults();
  const text = read(configPath);
  let parsed: EngineConfigValues = {};

  if (text !== undefined) {
    try {
      parsed = parseEngineConfigYaml(text);
    } catch {
      warn(
        `[castle:config] warn: malformed YAML in ${configPath} - using defaults`,
      );
    }
  }

  const enabled = parsed["plugins.dev.enabled"] === "true";
  if (enabled) {
    foldDevNamespace(values, parsed);
    applyEnvOverrides(values, env);
  }

  return {
    enabled,
    redRoot: root,
    configPath,
    values,
    get: (key) => values[key] ?? "",
  };
}

export function readEngineBackpressure(config: EngineConfig): string[] {
  const indexed: string[] = [];
  for (let i = 0; ; i++) {
    const value = config.values[`afk.backpressure.${i}`];
    if (value === undefined) break;
    if (value.trim() !== "") indexed.push(value);
  }
  if (indexed.length > 0) return indexed;

  const scalar = config.values["afk.backpressure"];
  return scalar && scalar.trim() !== "" ? [scalar] : [];
}

/**
 * The TYPE labels this repo declares HUMAN-ONLY (`afk.labels.hitl_types`), as a
 * YAML list or a single scalar. A dependent carrying one is promoted to the
 * human lane instead of the executable queue (red-skills #2966). A repo that
 * declares none gets `[]` — the reason an existing repo's promotions are
 * unchanged by this key's arrival.
 */
export function readEngineHitlTypeLabels(config: EngineConfig): string[] {
  const indexed: string[] = [];
  for (let i = 0; ; i++) {
    const value = config.values[`afk.labels.hitl_types.${i}`];
    if (value === undefined) break;
    if (value.trim() !== "") indexed.push(value.trim());
  }
  if (indexed.length > 0) return indexed;

  const scalar = config.values["afk.labels.hitl_types"];
  return scalar && scalar.trim() !== "" ? [scalar.trim()] : [];
}

export function readEngineLabelVocabulary(config: EngineConfig): EngineLabelVocabulary {
  return {
    hitlTypes: readEngineHitlTypeLabels(config),
    ready: config.get("afk.labels.ready"),
    running: config.get("afk.labels.running"),
    human: config.get("afk.labels.human"),
    needsTriage: config.get("afk.labels.needs_triage"),
    needsInfo: config.get("afk.labels.needs_info"),
    quarantine: config.get("afk.labels.quarantine"),
    dependencyBlocked: config.get("afk.labels.dependency_blocked"),
    blockedPrefix: config.get("afk.labels.blocked_prefix"),
    reqPrefix: config.get("afk.labels.req_prefix"),
  };
}
