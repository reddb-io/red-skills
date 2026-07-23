// Pinned claim-comment wire fixtures — executable documentation of every live
// variant of the `<!-- afk:claim … -->` marker (ADR 0066).
//
// The claim wire format has exactly one owner (`tracker/claim.ts`), but the
// comments it must PARSE were written by several generations of renderers:
// the dev-side renderer (with `ts=`, `reason=`, and the 🤖 human line), the
// retired tracker-twin renderer (no `ts=`, no `reason=`, bare human line), and
// hand-cases like legacy no-reason concedes. Every variant that can still sit
// on a live issue is pinned here, and both the castle suite and the consuming
// host's wire-compat test assert against this single table — a parser change
// that breaks any historical comment fails loudly on both sides.

import type { ClaimRecord, RawClaimComment } from "./claim.js";

export interface ClaimWireFixture {
  readonly name: string;
  readonly comment: RawClaimComment;
  /** Expected parse result — `[]` for negatives the parser must skip. */
  readonly expected: readonly ClaimRecord[];
}

export const CLAIM_WIRE_FIXTURES: readonly ClaimWireFixture[] = [
  {
    name: "dev claim with runner and ts",
    comment: {
      id: 3101,
      body:
        "<!-- afk:claim v1 worker=mbp.local:w6HSO-3 kind=claim runner=claude ts=2026-06-10T23:10:24Z -->\n" +
        "🤖 AFK claim by worker `mbp.local:w6HSO-3` (runner `claude`).",
      createdAt: "2026-06-10T23:10:30Z",
    },
    expected: [
      {
        commentId: 3101,
        worker: "mbp.local:w6HSO-3",
        kind: "claim",
        runner: "claude",
        createdAt: "2026-06-10T23:10:24Z",
      },
    ],
  },
  {
    name: "dev claim without ts falls back to the comment createdAt",
    comment: {
      id: 3102,
      body:
        "<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->\n" +
        "🤖 AFK claim by worker `host:w1` (runner `codex`).",
      createdAt: "2026-06-11T08:00:00Z",
    },
    expected: [
      {
        commentId: 3102,
        worker: "host:w1",
        kind: "claim",
        runner: "codex",
        createdAt: "2026-06-11T08:00:00Z",
      },
    ],
  },
  {
    name: "concede reason=lost",
    comment: {
      id: 3103,
      body:
        "<!-- afk:claim v1 worker=host:w1 kind=concede reason=lost runner=claude -->\n" +
        "🤖 AFK worker `host:w1` conceded this issue (lost the claim race to an earlier claimant).",
    },
    expected: [
      {
        commentId: 3103,
        worker: "host:w1",
        kind: "concede",
        runner: "claude",
        createdAt: undefined,
      },
    ],
  },
  {
    name: "concede reason=released",
    comment: {
      id: 3104,
      body:
        "<!-- afk:claim v1 worker=host:w2 kind=concede reason=released -->\n" +
        "🤖 AFK worker `host:w2` conceded this issue (released the claim it held).",
    },
    expected: [
      {
        commentId: 3104,
        worker: "host:w2",
        kind: "concede",
        runner: undefined,
        createdAt: undefined,
      },
    ],
  },
  {
    name: "legacy concede without reason",
    comment: {
      id: 3105,
      body:
        "<!-- afk:claim v1 worker=host:w3 kind=concede -->\n" +
        "🤖 AFK worker `host:w3` conceded this issue (lost the claim race or released).",
    },
    expected: [
      {
        commentId: 3105,
        worker: "host:w3",
        kind: "concede",
        runner: undefined,
        createdAt: undefined,
      },
    ],
  },
  {
    name: "retired tracker-twin claim (no ts, no emoji)",
    comment: {
      id: 3106,
      body:
        "<!-- afk:claim v1 worker=host:w4 kind=claim runner=codex -->\n" +
        "AFK claim by worker `host:w4` (runner `codex`).",
      createdAt: "2026-07-01T12:00:00Z",
    },
    expected: [
      {
        commentId: 3106,
        worker: "host:w4",
        kind: "claim",
        runner: "codex",
        createdAt: "2026-07-01T12:00:00Z",
      },
    ],
  },
  {
    name: "retired tracker-twin concede (no reason, no emoji)",
    comment: {
      id: 3107,
      body:
        "<!-- afk:claim v1 worker=host:w4 kind=concede runner=codex -->\n" +
        "AFK worker `host:w4` conceded this issue.",
    },
    expected: [
      {
        commentId: 3107,
        worker: "host:w4",
        kind: "concede",
        runner: "codex",
        createdAt: undefined,
      },
    ],
  },
  {
    name: "foreign-namespace marker is not a claim",
    comment: {
      id: 3108,
      body:
        "<!-- stn:claim v1 worker=stone:wOther kind=claim -->\n" +
        "A different tool's marker.",
    },
    expected: [],
  },
  {
    name: "worker-less marker is skipped",
    comment: {
      id: 3109,
      body: "<!-- afk:claim v1 kind=claim runner=claude -->\nMalformed.",
    },
    expected: [],
  },
  {
    name: "plain issue chatter is skipped",
    comment: {
      id: 3110,
      body: "Looks good to me — merging after CI.",
    },
    expected: [],
  },
  {
    name: "forged multi-marker body shares the single comment id",
    comment: {
      id: 3111,
      body:
        "<!-- afk:claim v1 worker=host:wA kind=claim -->\n" +
        "<!-- afk:claim v1 worker=host:wB kind=claim -->\n" +
        "Two markers, one comment: no forger claims a lower id than GitHub assigned.",
      createdAt: "2026-07-02T00:00:00Z",
    },
    expected: [
      {
        commentId: 3111,
        worker: "host:wA",
        kind: "claim",
        runner: undefined,
        createdAt: "2026-07-02T00:00:00Z",
      },
      {
        commentId: 3111,
        worker: "host:wB",
        kind: "claim",
        runner: undefined,
        createdAt: "2026-07-02T00:00:00Z",
      },
    ],
  },
];
