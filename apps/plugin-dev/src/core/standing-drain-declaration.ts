// standing-drain-declaration — the PRODUCTION reader of `plugins.dev.afk.standing`
// and the resolution a drain does when its caller states nothing (#4293).
//
// `readStandingDrain` parsed the block correctly from the day it landed and
// nothing called it: the consumer went with the dev CLI producer ADR 0147/0149
// demolished, and no replacement was wired. A repository could therefore declare
// a runner and a target, write a comment saying the declaration is what registers
// the project, and be wrong — `drain` composed its argv from the tool call alone,
// so a call with no runner dropped the declared one and admission fell back to
// the governed default.
//
// **A configuration key nothing reads is a promise the product cannot keep.**
// This module is where the block stops being decorative: it says what the block
// SAYS (a complete declaration, a named incomplete one, or silence), and it
// resolves the two facts a registration needs when the caller supplied neither.
//
// Silence is the ordinary answer and is never a fault — ADR 0067's posture is
// strict opt-in, so a repository that declared nothing must register nothing.
import { ACP_AGENT_IDS } from "@reddb-io/protocol-acp";
import { DEFAULT_FLEET_WIDTH } from "@reddb-io/shared/default-fleet-width.js";

import { loadConfig, type ConfigValues } from "./config.js";
import { readStandingDrain, type StandingDrainConfig } from "./standing-drain-config.js";
import { afkPaths } from "../runtime/wire/paths.js";

/** The two leaves a standing declaration is made of, in the spelling an operator writes. */
export const STANDING_DRAIN_KEYS = ["afk.standing.runner", "afk.standing.target"] as const;

/** A block that states both leaves usably: the only shape that registers anything. */
export interface StandingDrainDeclared {
  readonly kind: "declared";
  readonly standing: StandingDrainConfig;
}

/**
 * A block an operator wrote that cannot register anything.
 *
 * Reported rather than folded into silence, because the two are opposite
 * intentions: silence means "do not drain me" and this means "drain me" typed
 * wrong. `missing` empty with `stated` full is the second incomplete shape —
 * both leaves present, at least one value unusable (an unknown runner, a target
 * that is not a positive integer).
 */
export interface StandingDrainIncomplete {
  readonly kind: "incomplete";
  /** Keys the block gives a non-empty value. */
  readonly stated: readonly string[];
  /** Keys the block leaves empty. */
  readonly missing: readonly string[];
}

/** The block says nothing — the opt-in default, and never a fault. */
export interface StandingDrainAbsent {
  readonly kind: "absent";
}

export type StandingDrainReading = StandingDrainDeclared | StandingDrainIncomplete | StandingDrainAbsent;

/**
 * What the `afk.standing` block says. PURE.
 *
 * The completeness rule is `readStandingDrain`'s and stays there: this asks it
 * first and only classifies the refusal, so there is one definition of a usable
 * declaration rather than two that drift.
 */
export function readStandingDrainDeclaration(values: ConfigValues): StandingDrainReading {
  const standing = readStandingDrain(values);
  if (standing != null) return { kind: "declared", standing };
  const stated = STANDING_DRAIN_KEYS.filter((key) => (values[key] ?? "").trim() !== "");
  if (stated.length === 0) return { kind: "absent" };
  return {
    kind: "incomplete",
    stated,
    missing: STANDING_DRAIN_KEYS.filter((key) => !stated.includes(key)),
  };
}

/**
 * What this checkout's `.red/config.yaml` declares.
 *
 * A config that cannot be read declares nothing: the opt-in posture, not a
 * fault. A checkout with no `.red/` at all is the ordinary case (ADR 0067).
 */
export function readProjectStandingDrain(root: string): StandingDrainReading {
  try {
    return readStandingDrainDeclaration(loadConfig(afkPaths(root).configPath, { warn: () => undefined }));
  } catch {
    return { kind: "absent" };
  }
}

/** The usable declaration only, for a caller resolving a fallback. */
export function declaredStandingDrain(root: string): StandingDrainConfig | null {
  const reading = readProjectStandingDrain(root);
  return reading.kind === "declared" ? reading.standing : null;
}

/**
 * The target a registration carries: the caller's, else the declaration's, else
 * the governed default. PURE.
 *
 * Order is the whole rule. An explicitly stated width wins over a declaration
 * because the operator is typing NOW, and the declaration wins over the default
 * because the default is what a repository that declared nothing gets.
 */
export function resolveDrainTarget(stated: unknown, declared: StandingDrainConfig | null): number {
  if (typeof stated === "number" && Number.isInteger(stated) && stated >= 0) return stated;
  return declared?.target ?? DEFAULT_FLEET_WIDTH;
}

/**
 * The runner a registration names: the caller's, else the declaration's, else
 * none. PURE.
 *
 * `undefined` is a real answer and composes an argv with no `--child-agent`,
 * which is the daemon's governed default — the behaviour a repository that
 * declared nothing keeps.
 */
export function resolveDrainRunner(stated: unknown, declared: StandingDrainConfig | null): string | undefined {
  if (typeof stated === "string" && stated.length > 0) return stated;
  return declared?.runner;
}

/**
 * One line an operator can read about a block that registers nothing. PURE.
 *
 * Written where the adapter's stderr goes, because the failure it describes is
 * otherwise perfectly silent: the block is present, the file parses, and no
 * Worker is ever born for it.
 */
export function formatStandingDrainReading(root: string, reading: StandingDrainReading): string {
  if (reading.kind !== "incomplete") return "";
  const fault =
    reading.missing.length > 0
      ? `leaves ${reading.missing.join(" and ")} empty`
      : `states ${reading.stated.join(" and ")} with a value it cannot use — ` +
        `runner must be one of ${ACP_AGENT_IDS.join(", ")} and target a positive integer`;
  return (
    `redskilled MCP: ${root} declares plugins.dev.afk.standing but ${fault}, ` +
    "so it stays inert and no drain was registered for it. " +
    `State both ${STANDING_DRAIN_KEYS.join(" and ")} usably, or remove the block.`
  );
}
