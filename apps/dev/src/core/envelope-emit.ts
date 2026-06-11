// Terminal-Event Envelope emission for AFK workers (ports emit_envelope /
// build_envelope_summary / record_failure_markers / the envelope_emit_* family
// from afk.sh + lib/envelope.sh).
//
// Every terminal event of an iteration posts EXACTLY ONE structured comment on
// the issue. This module owns the failure family (blocked, no-sentinel,
// merge-conflict) and the success envelope (done):
//   - the summary line shape (worker `{id}` · status: … · duration: … · …),
//   - the per-status section set (blocked→notes; no-sentinel→notes+log;
//     merge-conflict→log; done→validation; + a trailing hooks block #215),
//   - the diff section (compare-link on a successful afk-attempts push, else a
//     local-worktree fallback line),
//   - the failure-only afk-attempts push, the `envelope.posted` signal, and the
//     history-event append.
//
// PURE assembly with injected gh/git/fs (no real network/disk in tests). Body
// composition reuses buildEnvelope from envelope.ts so the wire schema is
// defined exactly once. Section bodies are passed in as resolved strings — the
// caller owns reading notes/log/validation files; this module never reads the
// filesystem except through the injected marker writer.

import { buildEnvelope, type AttemptStatus, type EnvelopeSection } from "./envelope.js";
import { pushAttempt, type GitExec } from "./remote-branch.js";
import { historyAppend, type HistoryAppendFields, type HistoryClock, type HistoryEvent, type HistoryIO } from "./history.js";

/** Render N seconds as `<m>m<s>s`. Mirrors envelope_fmt_duration. */
export function fmtDuration(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.trunc(seconds) : 0;
  return `${Math.trunc(s / 60)}m${s % 60}s`;
}

/** The deterministic summary line for worker envelopes. Mirrors
 * envelope_build_summary EXACTLY — the merge SHA is wrapped in backticks so
 * GitHub auto-links it, and the duration is rendered through fmtDuration. */
export function buildEnvelopeSummary(input: {
  worker: string;
  status: AttemptStatus;
  durationS: number;
  diff: string;
  attempt: number;
  mergeSha?: string;
}): string {
  const mergePart = input.mergeSha ? ` · merge: \`${input.mergeSha}\`` : "";
  return `worker \`${input.worker}\` · status: ${input.status} · duration: ${fmtDuration(input.durationS)} · diff: ${input.diff} · attempt: ${input.attempt}${mergePart}`;
}

/** Body of the `data-section="diff"` block. When the attempt branch was pushed
 * (`remoteBranch` non-empty) the content is a compare-link to the pushed ref;
 * otherwise it embeds the local worktree path so a human can still find the
 * work. The diffstat line is always appended. Mirrors
 * envelope_build_diff_section. */
export function buildDiffSection(input: {
  repo: string;
  remoteBranch: string;
  worktreeRel: string;
  diffstat: string;
  /** The live `afk/{id}/{N}-slug` branch. On a terminal failure it survives on
   *  origin, so a clickable `tree/` link lets a human check it out to inspect or
   *  continue the work (#443). Empty/absent ⇒ no live link rendered. */
  liveBranch?: string;
}): string {
  const liveLink =
    input.liveBranch && input.repo
      ? `live branch: <a href="https://github.com/${input.repo}/tree/${input.liveBranch}">${input.liveBranch}</a>\n`
      : "";
  if (input.remoteBranch) {
    const url = `https://github.com/${input.repo}/compare/main...${input.remoteBranch}`;
    return `${liveLink}<a href="${url}">compare/main...${input.remoteBranch}</a>\n\n${input.diffstat}\n`;
  }
  return `${liveLink}push to \`afk-attempts/\` failed — local worktree: \`${input.worktreeRel}\`\n\n${input.diffstat}\n`;
}

/** The two attempt-ledger marker file paths a terminal FAILURE persists into
 * the iteration dir so the NEXT attempt can fetch the prior snapshot branch and
 * surface the recorded failure reason (issue #255). */
export interface FailureMarkers {
  /** `<iter_dir>/snapshot-branch.ref` — the afk-attempts/* ref the failed
   * attempt was pushed to. Omitted when `remoteRef` is empty. */
  snapshotBranchRef?: string;
  /** `<iter_dir>/failure.reason` — free-text reason (the envelope summary).
   * Omitted when empty. */
  failureReason?: string;
}

/** Build the marker-file content map for a terminal failure. Mirrors
 * record_failure_markers: each file carries a single trailing-newline line; an
 * empty value omits the file entirely. */
export function buildFailureMarkers(remoteRef: string, reason: string): FailureMarkers {
  const markers: FailureMarkers = {};
  if (remoteRef) markers.snapshotBranchRef = `${remoteRef}\n`;
  if (reason) markers.failureReason = `${reason}\n`;
  return markers;
}

/** Per-status section bodies the caller resolves before emitting. Each is the
 * already-read file content (or undefined when the caller has nothing). */
export interface SectionBodies {
  /** Handoff `<agent-notes>` body (blocked, no-sentinel). */
  notes?: string;
  /** Captured inner-agent stdout / merge-conflict tail (no-sentinel, merge-conflict). */
  log?: string;
  /** Package-aware feedback report (done). */
  validation?: string;
  /** One `<lifecycle> <command> exit=<rc>` line per user-declared hook that ran
   * (issue #215). Empty/undefined skips the section. Excluded on `discarded`. */
  hooks?: string;
}

/** Diff-section inputs for the failure family. */
export interface DiffInputs {
  repo: string;
  worktreeRel: string;
  diffstat: string;
  /** Live `afk/{id}/{N}-slug` branch, rendered as a clickable tree link (#443). */
  liveBranch?: string;
}

/** Assemble the ordered section list for a status. PURE — no push, no IO. The
 * `remoteBranch` is the push result (empty string ⇒ fallback diff body). The
 * hooks block always sits LAST so the existing notes < diff < log ordering
 * stays intact. Mirrors envelope_emit_attempt / envelope_emit_done section
 * selection. */
export function buildSections(
  status: AttemptStatus,
  sections: SectionBodies,
  diff: DiffInputs,
  remoteBranch: string,
): EnvelopeSection[] {
  const out: EnvelopeSection[] = [];
  const diffBody = (): string =>
    buildDiffSection({
      repo: diff.repo,
      remoteBranch,
      worktreeRel: diff.worktreeRel,
      diffstat: diff.diffstat,
      liveBranch: diff.liveBranch,
    });

  if (status === "done") {
    if (sections.validation !== undefined) out.push({ name: "validation", body: sections.validation });
  } else if (status === "blocked") {
    out.push({ name: "notes", body: sections.notes ?? "" });
    out.push({ name: "diff", body: diffBody() });
  } else if (status === "no-sentinel") {
    out.push({ name: "notes", body: sections.notes ?? "" });
    out.push({ name: "diff", body: diffBody() });
    out.push({ name: "log", body: sections.log ?? "", fenced: true });
  } else if (status === "merge-conflict") {
    out.push({ name: "diff", body: diffBody() });
    out.push({ name: "log", body: sections.log ?? "", fenced: true });
  }

  // Hooks block sits last across every status except discarded; skipped when
  // no user hook ran (empty hooks body).
  if (status !== "discarded" && sections.hooks) {
    out.push({ name: "hooks", body: sections.hooks });
  }
  return out;
}

/** Injected `gh issue comment` poster. Returns true on a successful (2xx) post.
 * Hard-wires the side effect the pure layer deliberately does not own. */
export type EnvelopePoster = (issue: number, body: string) => Promise<boolean>;

/** Injected writer for the failure marker files into the iteration dir. */
export type MarkerWriter = (markers: FailureMarkers) => Promise<void>;

/** Injected writer for the `envelope.posted` iteration-state signal. */
export type PostedWriter = (posted: boolean) => Promise<void>;

/** Everything the orchestration needs, all side effects injected. */
export interface EmitEnvelopeDeps {
  git: GitExec;
  poster: EnvelopePoster;
  /** Persists the failure marker files (record_failure_markers side effect). */
  writeMarkers: MarkerWriter;
  /** Persists `envelope.posted:=<bool>` to the iteration state file. */
  writePosted: PostedWriter;
  /** Appends the terminal history event to the ledger. */
  historyAppend?: typeof historyAppend;
  /** Injected history IO (filesystem swap for tests). */
  historyIO?: HistoryIO;
}

export interface EmitEnvelopeInput {
  status: AttemptStatus;
  issue: number;
  worker: string;
  durationS: number;
  /** Local worker branch to push on a terminal failure. */
  branch: string;
  attempt: number;
  /** Merge commit SHA for the done envelope (summary `· merge: …`). */
  mergeSha?: string;
  /** `+N -M` (or `merged`) for the summary line. */
  diff: string;
  /** afk-attempts/{worker}/{issue}-{slug} target ref (failure family). */
  remoteName?: string;
  /** owner/name, for the diff compare-link. */
  repo?: string;
  /** git repo dir to push from. */
  repoDir?: string;
  /** worktree path for the push-failed fallback line. */
  worktreeRel?: string;
  /** `+N -M files=K` for the diff section body. */
  diffstat?: string;
  /** Resolved section bodies (caller reads the files). */
  sections?: SectionBodies;
  /** History ledger path; when set, a terminal event is appended on success. */
  historyPath?: string;
  /** Clock stamped onto the history record. */
  historyClock?: HistoryClock;
  /** Event name for the history record (defaults from status). */
  historyEvent?: HistoryEvent;
  /** Extra history fields (runner, etc.). */
  historyFields?: HistoryAppendFields;
}

export interface EmitEnvelopeResult {
  /** The composed envelope body handed to the poster. */
  body: string;
  /** The summary line in the bash shape (merge sha in backticks). Note the
   * body's own summary, rendered by the reused buildEnvelope, leaves the merge
   * sha bare for GitHub auto-linking — see SKILL.md. */
  summary: string;
  /** True when the poster reported a successful post. */
  posted: boolean;
  /** True when the afk-attempts push was attempted and succeeded. */
  pushed: boolean;
  /** The afk-attempts ref the diff section links to ("" when no/failed push). */
  remoteBranch: string;
  /** The marker files written on a terminal failure (empty on done). */
  markers: FailureMarkers;
  /** Any best-effort warnings collected along the way. */
  warnings: string[];
}

/**
 * Orchestrate a single terminal-envelope emission, mirroring emit_envelope:
 *
 *   1. Build the summary line.
 *   2. On a terminal FAILURE: push the afk-attempts branch (best-effort —
 *      a failed push degrades the diff section to the fallback body) and write
 *      the snapshot-branch.ref / failure.reason markers regardless of the post
 *      outcome (they feed the next attempt, not the issue thread).
 *   3. Compose the per-status sections + body through buildEnvelope.
 *   4. POST via the injected poster.
 *   5. On a successful post: write `envelope.posted:=true` and append the
 *      terminal history event. On failure: write `envelope.posted:=false`.
 *
 * Every git/gh/fs touch is injected; nothing real runs in tests.
 */
export async function emitEnvelope(
  deps: EmitEnvelopeDeps,
  input: EmitEnvelopeInput,
): Promise<EmitEnvelopeResult> {
  const warnings: string[] = [];
  const summary = buildEnvelopeSummary({
    worker: input.worker,
    status: input.status,
    durationS: input.durationS,
    diff: input.diff,
    attempt: input.attempt,
    mergeSha: input.mergeSha,
  });

  const isFailure = input.status !== "done" && input.status !== "discarded";

  // --- failure-only afk-attempts push + markers (steps 2) ---
  let remoteBranch = "";
  let pushed = false;
  let markers: FailureMarkers = {};
  if (isFailure) {
    const remoteName = input.remoteName ?? "";
    if (input.repoDir && input.branch && remoteName) {
      const outcome = await pushAttempt(deps.git, input.repoDir, input.branch, remoteName);
      if (outcome.ok && outcome.ran) {
        remoteBranch = remoteName;
        pushed = true;
      } else if (outcome.warn) {
        warnings.push(outcome.warn);
      }
    }
    // The markers feed the next attempt regardless of whether the push or the
    // post below succeeds. The snapshot ref is the intended remote_name even
    // when the push fell through — mirrors emit_envelope recording snapshot_ref.
    markers = buildFailureMarkers(remoteName, summary);
    await deps.writeMarkers(markers);
  }

  // --- compose body (steps 3) ---
  const sectionList = buildSections(
    input.status,
    input.sections ?? {},
    {
      repo: input.repo ?? "",
      worktreeRel: input.worktreeRel ?? "",
      diffstat: input.diffstat ?? "",
      liveBranch: input.branch,
    },
    remoteBranch,
  );
  const body = buildEnvelope({
    status: input.status,
    worker: input.worker,
    duration: fmtDuration(input.durationS),
    diff: input.diff,
    attempt: input.attempt,
    mergeSha: input.mergeSha,
    sections: sectionList,
  });

  // --- post + envelope.posted signal (steps 4-5) ---
  const posted = await deps.poster(input.issue, body);
  await deps.writePosted(posted);
  if (!posted) {
    warnings.push(`failed to post envelope for #${input.issue} (status=${input.status})`);
  }
  // The local history ledger is independent of the GitHub comment POST (#625).
  // Append the terminal event whether or not the comment landed — a transient
  // post failure must not drop the `done`/`blocked` record that feeds the
  // monitor sparkline and the drain-promotion counters (the 2026-06-09 gap:
  // three issues landed but produced no `done` records because the append was
  // gated behind `posted === true`).
  if (input.historyPath && input.historyClock) {
    const append = deps.historyAppend ?? historyAppend;
    await append(
      input.historyPath,
      input.historyClock,
      input.historyEvent ?? defaultHistoryEvent(input.status),
      { worker: input.worker, issue: input.issue, ...input.historyFields },
      deps.historyIO,
    );
  }

  return { body, summary, posted, pushed, remoteBranch, markers, warnings };
}

/** Map a terminal status onto its ledger event name. `done` → "done", every
 * terminal failure → "blocked" mirrors how the bash ledger buckets non-done
 * terminal events for the sparkline. */
function defaultHistoryEvent(status: AttemptStatus): HistoryEvent {
  return status === "done" ? "done" : "blocked";
}
