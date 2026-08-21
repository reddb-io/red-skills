// standing-drain-start — the seam that makes a standing declaration REGISTER,
// without a human typing `drain` (#4293).
//
// A project's standing block is documented as the way it keeps itself registered
// across daemon restarts, plugin reloads and reboots. It only can be if something
// reads it on a surface that runs by itself, and the surface that runs by itself
// is the Plugin MCP adapter: a coder CLI mounts it at session start, so every
// session of every enabled project passes through here, and a project whose
// registration lapsed while the daemon was down is re-stated by the next one.
//
// Three properties are load-bearing and each is a refusal:
//
//  1. **STRICTLY OPT-IN.** A project that declared nothing registers nothing —
//     ADR 0067's posture. Boot-time work that starts a drain nobody asked for
//     would be worse than the defect it fixes.
//  2. **IDEMPOTENT.** The daemon's `drain` is ensure-style and its registration
//     path treats a record already held as the answer, so re-stating on every
//     session is the intended shape rather than a duplicate.
//  3. **NEVER FATAL.** A daemon that does not answer must not cost the operator
//     their tool surface. Every failure is reported and swallowed; the MCP
//     session keeps serving, and the operator's next explicit `drain` is
//     unaffected.
import { drainInputFor } from "../core/drain-registration-resolve.js";
import {
  formatStandingDrainReading,
  readProjectStandingDrain,
  type StandingDrainReading,
} from "../core/standing-drain-declaration.js";

/** What the seam did, in the one fact a caller or a test needs back. */
export type StandingDrainStartOutcome =
  /** The project declared nothing. Nothing was registered, and that is correct. */
  | { readonly kind: "undeclared" }
  /** The project declared something unusable; the operator was told. */
  | { readonly kind: "incomplete"; readonly detail: string }
  /** The checkout cannot name a repository, so there is no queue to register. */
  | { readonly kind: "unregisterable" }
  /** The declaration reached the daemon. */
  | { readonly kind: "registered"; readonly runner: string; readonly target: number }
  /** The declaration was read and the daemon refused or did not answer. */
  | { readonly kind: "unreachable"; readonly detail: string };

export interface StandingDrainStartDeps {
  /** The published version a birth reaches for (ADR 0091). */
  readonly version: string;
  /** This session's project root, resolved once the transport is live. */
  root(): Promise<string> | string;
  /** Send the ensure-style `drain` the declaration composes. */
  drain(input: Record<string, unknown>): Promise<unknown>;
  /** Where an operator reads about a block that registers nothing. */
  warn?(line: string): void;
  /** Seams, so the rule is testable without a checkout or a daemon. */
  reading?(root: string): StandingDrainReading;
  input?(root: string, version: string, stated: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Register this project's declared standing drain, once, at MCP startup.
 *
 * Resolves to an outcome and never rejects: the caller fires it and returns to
 * serving tools.
 */
export async function ensureStandingDrain(
  deps: StandingDrainStartDeps,
): Promise<StandingDrainStartOutcome> {
  const warn = deps.warn ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let root: string;
  try {
    root = await deps.root();
  } catch (error) {
    return { kind: "unreachable", detail: String(error) };
  }
  const reading = (deps.reading ?? readProjectStandingDrain)(root);
  if (reading.kind === "absent") return { kind: "undeclared" };
  if (reading.kind === "incomplete") {
    const detail = formatStandingDrainReading(root, reading);
    warn(detail);
    return { kind: "incomplete", detail };
  }
  const { runner, target } = reading.standing;
  try {
    const input = (deps.input ?? drainInputFor)(root, deps.version, { runner, target });
    // A registration is what the daemon births from; a drain without one records
    // an intent nobody polls for. Saying so beats sending it.
    if (input.registration == null) return { kind: "unregisterable" };
    await deps.drain(input);
    return { kind: "registered", runner, target };
  } catch (error) {
    warn(
      `redskilled MCP: ${root} declares a standing drain at ${runner} x${target}, ` +
        `and registering it failed — ${String(error)}`,
    );
    return { kind: "unreachable", detail: String(error) };
  }
}
