/**
 * producer-self-replace — how a per-project producer on a superseded bundle
 * becomes one on the current.
 *
 * The daemon already answered this for itself (`redskilled/self-replace.ts`): it
 * probes the published version on an interval and comes back on the new bundle,
 * because a long-running process on a superseded bundle killed 21 Workers in 20
 * minutes. The per-project producer had no equivalent — it resolved a bundle once
 * at launch and never asked again — so every release stranded it: `project_start`
 * reported `bundle_version: 3.0.3` while npm already served 3.0.4, every Worker
 * born afterwards boot-halted on skew, and the producer went on reporting itself
 * healthy (#2925). Restarting by hand is not the cure: three releases landed
 * inside one hour, faster than an operator can chase.
 *
 * Four rules decide this module, and they are the daemon's rules deliberately.
 *
 * **A replacement is a restart, not an evacuation.** Workers are born by the host
 * daemon (ADR 0130) and outlive the producer that asked for them; the successor
 * adopts them by pid. Nothing is stopped, drained or re-queued.
 *
 * **The version a producer reports is the version it RUNS, always.** The published
 * answer is carried beside it, never folded into it — substituting the resolved
 * version for the running one is exactly how a stale process reports a healthy
 * zero skew while every Worker boot-halts (#2809). This module *decides*; it
 * never renames what is running.
 *
 * **A local build replaces itself with nothing.** A source checkout is not a
 * point on the published lane, so comparing it to a release is meaningless and
 * acting on the comparison would take a developer's own producer away
 * mid-session.
 *
 * **A major boundary is held.** A breaking change must not arrive on a machine
 * because a background timer noticed it, so the decision only ever adopts inside
 * the running major.
 *
 * PURE — the probe is injected, and nothing here reads a clock, a socket or a
 * file.
 */
import { compareSemver, semverParts } from "./bundle-version.js";

/** How long the producer waits between published-version checks — the daemon's cadence. */
export const DEFAULT_PRODUCER_REPLACE_CHECK_MS = 900_000;

/** Operator override for the cadence; `0` turns the check off entirely. */
export const PRODUCER_REPLACE_CHECK_ENV = "RED_AFK_REPLACE_CHECK_MS";

export type ProducerReplacementHoldReason =
  | "local-build"
  | "published-unknown"
  | "no-newer-version"
  | "major-held";

/** The decision itself, and the version it names — never the version being run. */
export type ProducerReplacement = { readonly act: "replace"; readonly to: string };

export type ProducerReplacementDecision =
  | { readonly act: "hold"; readonly reason: ProducerReplacementHoldReason }
  | ProducerReplacement;

export interface PlanProducerReplacementInput {
  /** The version this process is RUNNING — never the one it resolved. */
  readonly running: string;
  /** The published answer; null or unparseable is unknown, never a match. */
  readonly published: string | null | undefined;
}

/** Decide whether this producer should hand over to a newer bundle. PURE. */
export function planProducerReplacement(
  input: PlanProducerReplacementInput,
): ProducerReplacementDecision {
  const running = input.running.trim();
  if (isLocalProducerBuild(running)) return { act: "hold", reason: "local-build" };
  const published = (input.published ?? "").trim();
  const parsed = semverParts(published);
  if (!published || parsed === null) return { act: "hold", reason: "published-unknown" };
  if (compareSemver(published, running) <= 0) return { act: "hold", reason: "no-newer-version" };
  // A newer MAJOR is reported by the surfaces and adopted by nobody on a timer.
  if (parsed[0] !== semverParts(running)?.[0]) return { act: "hold", reason: "major-held" };
  return { act: "replace", to: published };
}

/**
 * A prerelease, a build-metadata version or anything unparseable is a local
 * build: it is the intended runtime for whoever started it, and no release
 * supersedes it. Matches `isLocalDevBuild`'s rule for the launch path, plus the
 * daemon's reading of an unparseable version as local.
 */
export function isLocalProducerBuild(version: string): boolean {
  const trimmed = version.trim();
  if (semverParts(trimmed) === null) return true;
  return /^\d+\.\d+\.\d+[-+]/.test(trimmed);
}

/** The configured cadence between checks, in milliseconds. PURE. */
export function producerReplaceCheckMs(env: NodeJS.ProcessEnv): number {
  const raw = (env[PRODUCER_REPLACE_CHECK_ENV] ?? "").trim();
  if (!raw) return DEFAULT_PRODUCER_REPLACE_CHECK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PRODUCER_REPLACE_CHECK_MS;
  return Math.floor(parsed);
}

export interface ProducerReplacementWatchInput {
  /** The version this process is RUNNING. */
  readonly running: string;
  /** One published-version read; a throw is read as unknown, never as a match. */
  readonly probePublished: () => Promise<string | null | undefined>;
}

/**
 * The standing question "has the published version moved?", asked one tick at a
 * time.
 *
 * A decision, once made, is BINDING: the producer stops feeding new Workers on
 * the strength of it, so letting a later flapping answer unmake it would leave a
 * producer that had already announced a handover serving the old bundle again.
 * A local build never even probes — asking would spend a registry read on a
 * comparison whose answer can only be "hold".
 */
export interface ProducerReplacementWatch {
  /** Ask once. Returns this tick's decision, binding or not. */
  tick(): Promise<ProducerReplacementDecision>;
  /** The binding decision, or null while none has been made. */
  decided(): ProducerReplacement | null;
}

export function createProducerReplacementWatch(
  input: ProducerReplacementWatchInput,
): ProducerReplacementWatch {
  let decision: ProducerReplacement | null = null;
  const local = isLocalProducerBuild(input.running);
  return {
    async tick(): Promise<ProducerReplacementDecision> {
      if (decision !== null) return decision;
      if (local) return { act: "hold", reason: "local-build" };
      let published: string | null | undefined;
      try {
        published = await input.probePublished();
      } catch {
        // An unreachable registry costs the check, never the producer: unknown
        // stays unknown, and the next tick asks again.
        published = null;
      }
      const planned = planProducerReplacement({ running: input.running, published });
      if (planned.act === "replace") decision = planned;
      return planned;
    },
    decided: () => decision,
  };
}

/** A live Worker the successor inherits, by the slot it occupies. */
export interface ProducerSlotPid {
  readonly slot: number;
  readonly pid: number;
}

/** Everything the successor needs to continue this producer's work. */
export interface ProducerHandover {
  /** The version the successor must run — pinned, so the skew cannot survive it. */
  readonly to: string;
  readonly target: number;
  /** Live Workers, handed over rather than stopped: they outlive this process. */
  readonly adoptSlotPids: readonly ProducerSlotPid[];
}

export interface ProducerHandoverIO {
  /** Give up this producer's pid identity so the successor can take it. */
  release(): Promise<void> | void;
  /** Start the successor at the pinned version; null when it never came up. */
  spawn(handover: ProducerHandover): Promise<number | null>;
  log(line: string): void;
}

export interface ProducerHandoverResult {
  readonly ok: boolean;
  readonly pid: number | null;
  /** Present only on failure — the reason, in the words an operator needs. */
  readonly error?: string;
}

/**
 * Complete one handover, on a producer that has ALREADY stopped its tick loop.
 *
 * The order is not negotiable: this process releases its pid identity FIRST and
 * only then starts a successor — one supervisor per project is enforced by that
 * identity, so a successor racing a live holder is refused on the spot and the
 * project is left on the old bundle by a producer that believed it had handed
 * over. The live Workers are carried across rather than stopped, because they
 * are the daemon's units and outlive whoever asked for them.
 */
export async function handOverProducer(
  handover: ProducerHandover,
  io: ProducerHandoverIO,
): Promise<ProducerHandoverResult> {
  io.log(
    `producer self-replace: handing over to ${handover.to} ` +
      `(target=${handover.target}, live workers adopted=${handover.adoptSlotPids.length})`,
  );
  await io.release();
  try {
    const pid = await io.spawn(handover);
    if (pid === null) {
      const error = `the successor at ${handover.to} published no pid within the boot window`;
      io.log(`producer self-replace failed: ${error}`);
      return { ok: false, pid: null, error };
    }
    io.log(`producer self-replace: ${handover.to} is live (pid=${pid})`);
    return { ok: true, pid };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    io.log(`producer self-replace failed: ${error}`);
    return { ok: false, pid: null, error };
  }
}
