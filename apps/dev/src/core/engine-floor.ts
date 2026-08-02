// engine-floor — dispatch refuses (or loudly warns about) a superseded engine.
//
// **A merged fix that never runs is not a merged fix.** All three forensic
// recoveries on 2026-08-01 were the same shape: the repair landed, main was
// green, and every dispatched Worker went on running the engine from before the
// repair — because nothing at dispatch time ever compared the engine it was
// about to run against the version the registry had published. The skew was
// measurable the whole time (`published-version.ts` has owned that answer since
// #2809); nobody asked it at the one moment it decides what runs.
//
// So the dispatch asks. The resolved engine's build-info is compared to the
// published dist-tag, and a superseded engine either REFUSES or warns loudly,
// per the declared policy — naming both versions and the span of fixes the
// dispatch would forfeit. The class stops being silent either way.
//
// Two things it deliberately never does:
//
//  1. **Kill an offline dispatch.** A registry it cannot reach is a fact about
//     the network, not about the engine. Unreachable degrades to a warning and
//     proceeds; a floor that grounds a fleet whenever npm hiccups would be a
//     worse outage than the one it prevents.
//  2. **Refuse on hearsay.** Only a FRESH published answer can trigger a hard
//     refusal. A replayed record, an installed plugin or a cached bundle is
//     evidence enough to warn and never enough to stop the work, because the
//     newest thing this host happens to know about is not the same claim as
//     "the registry says you are behind".
//
// Pure. Every input is passed in, so the verdict a test poses and the verdict a
// dispatch acts on are produced by the same function.

import { compareSemver, semverParts } from "./bundle-version.js";
import { isLocalProducerBuild } from "./producer-self-replace.js";
import type { PublishedVersionObservation, PublishedVersionSource } from "./published-version.js";

/** The config key declaring what a superseded engine costs a dispatch. */
export const ENGINE_FLOOR_CONFIG_KEY = "dev.dispatch.engine_floor";

/**
 * The declared policy. `refuse` is a hard stop, `warn` dispatches loudly, `off`
 * silences the check entirely.
 *
 * The DEFAULT is `warn`, and the choice is deliberate: the defect class this
 * closes is *silence*, which a warning ends, while a refusal by default turns
 * every host that is merely one release behind into a host that cannot dispatch
 * at all — a self-inflicted outage in exchange for a problem the warning
 * already surfaces. A fleet that must never run a superseded engine states
 * `refuse` and gets exactly that.
 */
export type EngineFloorPolicy = "refuse" | "warn" | "off";

export const DEFAULT_ENGINE_FLOOR_POLICY: EngineFloorPolicy = "warn";

const POLICIES: readonly EngineFloorPolicy[] = ["refuse", "warn", "off"];

/** Parse a declared policy; anything unrecognised falls back to the default
 * rather than throwing, because a typo in config must not ground a dispatch. */
export function parseEngineFloorPolicy(raw: string | undefined | null): EngineFloorPolicy {
  const value = String(raw ?? "").trim().toLowerCase();
  return (POLICIES as readonly string[]).includes(value)
    ? (value as EngineFloorPolicy)
    : DEFAULT_ENGINE_FLOOR_POLICY;
}

/** What the dispatch does with the verdict. */
export type EngineFloorDecision = "proceed" | "warn" | "refuse";

/**
 * Why. `superseded` is a fresh registry answer that the engine is behind;
 * `superseded-unverified` is the same skew read off weaker evidence, which can
 * only ever warn; `registry-unreachable` is the offline degrade;
 * `engine-unknown` is a build-info that measured nothing; `local-build` is a
 * source checkout or prerelease, which no release supersedes; `ahead` is an
 * engine NEWER than the dist-tag (a canary), never a reason to stop.
 */
export type EngineFloorCode =
  | "disabled"
  | "current"
  | "ahead"
  | "superseded"
  | "superseded-unverified"
  | "registry-unreachable"
  | "engine-unknown"
  | "local-build";

export interface EngineFloorInput {
  /** The version of the engine this dispatch would actually run. */
  readonly engineVersion: string | undefined;
  /** The published answer, or null when the lookup produced nothing at all. */
  readonly published: PublishedVersionObservation | null;
  /** The registry read's own failure, when it threw. */
  readonly registryError?: string | undefined;
  readonly policy: EngineFloorPolicy;
}

export interface EngineFloorVerdict {
  readonly decision: EngineFloorDecision;
  readonly code: EngineFloorCode;
  readonly policy: EngineFloorPolicy;
  readonly engine_version: string | null;
  readonly published_version: string | null;
  readonly published_source: PublishedVersionSource | null;
  /** The operator-facing sentence; empty only when the verdict is silent. */
  readonly message: string;
}

/** The repair, stated once so every surface prescribes the same one. */
export const ENGINE_FLOOR_REPAIR =
  "let self-update reconcile the bundle (or warm it: `npx -y -p @reddb-io/red-skills@<version> red-skills-dev --version`), then dispatch again";

/**
 * Judge one dispatch's engine against the published dist-tag. PURE.
 *
 * The order matters: policy first (an `off` check reads nothing), then the
 * engine's own knowability, then the registry's, and only then the comparison —
 * so no branch can reach a skew verdict without both sides measured. An
 * unmeasured side is reported as unknown, never collapsed into a confident
 * match, which is the same rule `publishedVersionReport` holds for skew (#2752).
 */
export function evaluateEngineFloor(input: EngineFloorInput): EngineFloorVerdict {
  const engine = trimmed(input.engineVersion);
  const published = publishedVersion(input.published?.version ?? undefined);
  const source = input.published?.version ? input.published.source : null;
  const base = {
    policy: input.policy,
    engine_version: engine ?? null,
    published_version: published ?? null,
    published_source: source,
  } as const;

  if (input.policy === "off") {
    return { ...base, decision: "proceed", code: "disabled", message: "" };
  }

  if (!engine) {
    return {
      ...base,
      decision: "warn",
      code: "engine-unknown",
      message:
        "⚠ engine floor: the engine this dispatch resolved reports no version, so it cannot be " +
        "compared against the published dist-tag. Dispatching anyway — an unknown version is not " +
        "evidence of a current one.",
    };
  }

  // A source checkout or prerelease is the intended runtime for whoever started
  // it; no release supersedes it, and comparing it to one measures nothing.
  if (isLocalProducerBuild(engine)) {
    return { ...base, decision: "proceed", code: "local-build", message: "" };
  }

  if (!published) {
    return {
      ...base,
      decision: "warn",
      code: "registry-unreachable",
      message:
        `⚠ engine floor: could not resolve the published dist-tag` +
        (input.registryError ? ` (${input.registryError})` : "") +
        `, so engine ${engine} is unchecked. Dispatching anyway — an unreachable registry must ` +
        `never ground an offline dispatch.`,
    };
  }

  if (compareSemver(published, engine) <= 0) {
    const ahead = compareSemver(engine, published) > 0;
    return {
      ...base,
      decision: "proceed",
      code: ahead ? "ahead" : "current",
      message: "",
    };
  }

  // Only a fresh registry read earns a refusal. Weaker evidence — a replayed
  // record, an installed plugin, a cached bundle — is the newest thing this HOST
  // knows, not the newest thing published, so it warns and lets the work run.
  const verified = input.published?.source === "registry" && input.published.stale === false;
  const forfeits =
    `it forfeits every fix published in ${engine} → ${published}, which is exactly how a merged ` +
    `fix keeps not running`;
  if (!verified) {
    return {
      ...base,
      decision: "warn",
      code: "superseded-unverified",
      message:
        `⚠ engine floor: engine ${engine} looks superseded by ${published} ` +
        `(source ${source}, not a fresh registry read), so ${forfeits}. Dispatching anyway — ` +
        `a refusal is never taken on unverified evidence. Repair: ${ENGINE_FLOOR_REPAIR}.`,
    };
  }

  if (input.policy === "refuse") {
    return {
      ...base,
      decision: "refuse",
      code: "superseded",
      message:
        `✗ engine floor: refusing to dispatch engine ${engine} — the published dist-tag is ` +
        `${published}, so ${forfeits}. Repair: ${ENGINE_FLOOR_REPAIR}. ` +
        `Policy: ${ENGINE_FLOOR_CONFIG_KEY}=refuse (set \`warn\` to dispatch loudly instead).`,
    };
  }

  return {
    ...base,
    decision: "warn",
    code: "superseded",
    message:
      `⚠ engine floor: engine ${engine} is superseded — the published dist-tag is ${published}, ` +
      `so ${forfeits}. Dispatching anyway. Repair: ${ENGINE_FLOOR_REPAIR}. ` +
      `Policy: ${ENGINE_FLOOR_CONFIG_KEY}=warn (set \`refuse\` to make this a hard stop).`,
  };
}

function trimmed(value: string | undefined): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

/**
 * A published version must PARSE to count. An unparseable dist-tag answer is
 * indistinguishable from no answer, and reading it as one is what keeps an
 * unreachable registry from ever masquerading as a verdict.
 */
function publishedVersion(value: string | undefined): string | undefined {
  const text = trimmed(value);
  return text && semverParts(text) ? text : undefined;
}
