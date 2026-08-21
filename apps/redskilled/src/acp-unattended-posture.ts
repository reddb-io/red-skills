/**
 * acp-unattended-posture — how each catalog Agent is made able to WORK unattended.
 *
 * A Worker's turn runs with nobody at the keyboard, and `acp-permission.ts` is
 * deliberate about what that means: an uncovered decision is `hitl-required`,
 * which the child receives as `outcome: cancelled`. Every coding Agent shipped
 * today reads a cancelled permission as an INTERRUPT and aborts the whole turn.
 * So an Agent left on its ask-for-approval defaults is admitted, investigates,
 * decides, calls its first write — and dies there. That was observed live for
 * codex (#4230: `aborted by user after 0.1s`, stopReason `cancelled`) and again
 * for claude-code while this module was written (#4278).
 *
 * The posture is therefore DECLARED, per Agent, beside the evidence that found
 * it — and it is declared for ALL of them, including the ones that need
 * nothing, because "this Agent needs nothing" is a finding somebody made and
 * not an absence a reader can tell apart from an omission. The descriptor type
 * requires the field, so a sixth Agent cannot land unpostured.
 *
 * What a posture grants is the trust the disposable Worker workspace already
 * carries (ADR 0148): the product's isolation is that workspace, its cgroup and
 * the Worker's terminal policy — never the child's own prompt-for-approval
 * loop, which nobody is there to answer.
 *
 * A posture is not per-Worker ISOLATION. Isolation is `acp-agent-home.ts`, and
 * the two are declared apart because an Agent can need one without the other.
 */
import type { AcpAgentId } from "@reddb-io/protocol-acp";

/**
 * The one mechanism that grants one Agent its unattended posture.
 *
 * Each arm carries exactly what its mechanism consumes; a single shape with
 * three optional fields would let an Agent declare a posture establishing
 * nothing. Neither mechanism arm is adapter-only — a native Agent launched from
 * PATH carries a posture the same way.
 */
export type AcpUnattendedPosture =
  /** Arguments appended after the launch command. */
  | {
    readonly kind: "launch-args";
    readonly args: readonly [string, ...string[]];
    readonly evidence: string;
  }
  /** An ACP `session/set_mode` the Worker issues right after `session/new`. */
  | {
    readonly kind: "session-mode";
    readonly modeId: string;
    readonly evidence: string;
  }
  /** The Agent never asks. The reason is the finding, not a shrug. */
  | { readonly kind: "none-needed"; readonly reason: string };

/**
 * What the opencode permission engine allows before anybody configures it.
 *
 * redcode and opencode are the same engine, and its built-in table (read out of
 * the shipped `opencode` 1.18.18 binary, and the reason every live redcode
 * drain has worked unpostured) allows every tool by default, allows `edit` for
 * paths under the session cwd and the temp dir, and reserves `ask` for edits
 * OUTSIDE them. A Worker's child is launched with its own worktree as cwd, so
 * the work it was born to do is inside the allowed set.
 */
const OPENCODE_ENGINE_DEFAULTS =
  "redcode and opencode share one permission engine whose built-in table is `{\"*\":\"allow\", …}` with "
  + "`edit` allowed under the session cwd and the temp dir. A Worker's child runs with its own worktree as "
  + "cwd, so its work never leaves the allowed set and no ACP permission request is raised.";

/**
 * Every Agent's posture, keyed by the wire's own id list.
 *
 * `Record<AcpAgentId, …>` is total by construction: a sixth id fails to compile
 * here before it can reach a Worker unpostured.
 */
export const ACP_UNATTENDED_POSTURES: Readonly<Record<AcpAgentId, AcpUnattendedPosture>> = {
  redcode: {
    kind: "none-needed",
    reason: `redcode is the product's own child and asks for nothing: ${OPENCODE_ENGINE_DEFAULTS}`,
  },
  // Probed 2026-08-21 against the pinned artifact over stdio. DEFAULT: the
  // session opens `currentModeId: "default"` and the first file write raises
  // `session/request_permission` ("Write …/PROBE.txt"); answered the way an
  // unattended turn answers it, the turn ends with nothing written. With
  // `session/set_mode` → `bypassPermissions` sent first: zero permission
  // requests, `stopReason: "end_turn"`, the file on disk.
  "claude-code": {
    kind: "session-mode",
    modeId: "bypassPermissions",
    evidence:
      "claude-code-acp@0.16.2 parses no argv at all (`--help` prints nothing; `dist/index.js` reads none), so "
      + "no launch flag can carry this. Its `session/new` advertises `bypassPermissions` among the session "
      + "modes, and setting it takes a probed write from two refused permission requests to `end_turn` with "
      + "the file written.",
  },
  // #4230, observed live on 4.1.15 before this module existed.
  codex: {
    kind: "launch-args",
    args: ["-c", "approval_policy=never", "-c", "sandbox_mode=danger-full-access"],
    evidence:
      "codex-acp@0.16.0 forwards `-c key=value` into codex's own config. Left on its defaults it aborted the "
      + "turn on the first apply_patch ('aborted by user after 0.1s', turn_aborted reason interrupted, "
      + "stopReason cancelled).",
  },
  // Probed 2026-08-21: `pi-acp --help` prints nothing, and `dist/index.js`
  // tests process.argv for exactly one token, `--terminal-login`. Its only
  // `conn.requestPermission` callers are `handleExtensionSelect` and
  // `handleExtensionConfirm` — UI a pi EXTENSION raises. An ordinary tool call
  // never reaches the client, because the adapter runs `pi --mode rpc` and pi
  // reads, writes and executes locally (its README says so under Limitations:
  // "No ACP filesystem delegation and no ACP terminal delegation. pi
  // reads/writes and executes locally.").
  pi: {
    kind: "none-needed",
    reason:
      "pi-acp@0.0.33 accepts exactly one argument, `--terminal-login`, and exposes no permission surface for "
      + "tool calls: it runs `pi --mode rpc`, which reads, writes and executes locally, so a write never "
      + "becomes an ACP permission request. Only a pi extension's own select/confirm UI reaches the client.",
  },
  opencode: {
    kind: "none-needed",
    reason: `opencode asks for nothing inside its own workspace: ${OPENCODE_ENGINE_DEFAULTS}`,
  },
};

/** One Agent's declared posture. PURE. */
export function unattendedPostureFor(agent: AcpAgentId): AcpUnattendedPosture {
  return ACP_UNATTENDED_POSTURES[agent];
}

/** The arguments a posture appends to the launch, or none. PURE. */
export function unattendedLaunchArgs(posture: AcpUnattendedPosture): readonly string[] {
  return posture.kind === "launch-args" ? posture.args : [];
}

/** The ACP session mode a posture asks for after `session/new`, or none. PURE. */
export function unattendedSessionMode(posture: AcpUnattendedPosture): string | undefined {
  return posture.kind === "session-mode" ? posture.modeId : undefined;
}
