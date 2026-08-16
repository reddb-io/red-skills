// Terminal-Event Envelope emission for AFK workers (ports emit_envelope /
// build_envelope_summary / record_failure_markers / the envelope_emit_* family
// from afk.sh + lib/envelope.sh).
//
// Every terminal event of an iteration posts EXACTLY ONE structured comment on
// the issue. This module owns the failure family (blocked, no-sentinel,
// merge-conflict) and the success envelope (done):
//   - the summary line shape (worker `{id}` · status: … · duration: … · …),
//   - the per-status section set (blocked→notes; no-sentinel→notes+log;
//     merge-conflict→log; done→validation; blocked→notes+optional validation;
//     + a trailing hooks block #215),
//   - the diff section (live worker branch + local-worktree fallback),
//   - the `envelope.posted` signal and the history-event append.
//
// PURE assembly with injected gh/git/fs (no real network/disk in tests). Body
// composition reuses buildEnvelope from envelope.ts so the wire schema is
// defined exactly once. Section bodies are passed in as resolved strings — the
// caller owns reading notes/log/validation files; this module never reads the
// filesystem except through the injected marker writer.

import { buildEnvelope, type AttemptStatus, type EnvelopeSection } from "./envelope.js";
import type { GitExec } from "./remote-branch.js";
import { historyAppend, type HistoryAppendFields, type HistoryClock, type HistoryEvent, type HistoryIO } from "./history.js";
import { enrichIssueReferences, type IssueReferenceLookup } from "./issue-reference.js";
import { parseLane } from "./jsonl-log.js";
import { encode, type JsonValue } from "@reddb-io/toon";

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

/** Body of the `data-section="diff"` block. Terminal failures use the live
 * worker branch as the durable forensic ref; no separate snapshot branch is
 * pushed or linked. The diffstat line is always appended. Mirrors
 * envelope_build_diff_section. */
export function buildDiffSection(input: {
  repo: string;
  /** Legacy field retained for callers/tests that predate ADR 0103. Ignored. */
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
  return `${liveLink}local worktree: \`${input.worktreeRel}\`\n\n${input.diffstat}\n`;
}

/** The marker files a terminal FAILURE persists into the worker's issue
 * workspace so an automatic re-queue can carry the failure forward (ADR 0103).
 * Read back by `core/prev-failure.ts`; there is no attempt level and no ledger. */
export interface FailureMarkers {
  /** `<workspace>/failure.reason` — free-text reason (the envelope summary).
   * Omitted when empty. */
  failureReason?: string;
  /** `<workspace>/envelope.ref` — where the terminal Envelope was posted.
   * Omitted when the repo is unknown. */
  envelopeRef?: string;
}

/** Build the marker-file content map for a terminal failure. Each value carries
 * a single trailing newline; an empty input writes no file. */
export function buildFailureMarkers(reason: string, envelopeRef?: string): FailureMarkers {
  const markers: FailureMarkers = {};
  if (reason) markers.failureReason = `${reason}\n`;
  if (envelopeRef) markers.envelopeRef = `${envelopeRef}\n`;
  return markers;
}

/** The terminal Envelope's location: the issue thread it is posted into.
 * Empty when the repo is unknown (nothing usable to point the next run at). */
export function envelopeReference(repo: string | undefined, issue: number): string {
  return repo ? `https://github.com/${repo}/issues/${issue}` : "";
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
  /** Holistic 0–1 quality score from the existing gate reviewer pass. */
  appraisal?: string;
  /** Resolved worker base ref/sha evidence (issue #1380). */
  base?: string;
  /** Aggregatable Re-seed rounds/cause fact for a landed Worker (#3843). */
  reseed?: string;
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
    if (sections.appraisal !== undefined) out.push({ name: "appraisal", body: sections.appraisal });
    if (sections.validation !== undefined) out.push({ name: "validation", body: sections.validation });
    if (sections.reseed !== undefined) out.push({ name: "reseed", body: sections.reseed, fenced: true, fenceLang: "toon" });
    if (sections.base !== undefined) out.push({ name: "base", body: sections.base });
  } else if (status === "blocked") {
    out.push({ name: "notes", body: sections.notes ?? "" });
    if (sections.validation !== undefined) out.push({ name: "validation", body: sections.validation });
    out.push({ name: "diff", body: diffBody() });
    if (sections.base !== undefined) out.push({ name: "base", body: sections.base });
  } else if (status === "no-sentinel") {
    out.push({ name: "notes", body: sections.notes ?? "" });
    out.push({ name: "diff", body: diffBody() });
    out.push({ name: "log", body: renderLogTailToon(sections.log ?? ""), fenced: true, fenceLang: "toon" });
    if (sections.base !== undefined) out.push({ name: "base", body: sections.base });
  } else if (status === "merge-conflict") {
    out.push({ name: "diff", body: diffBody() });
    out.push({ name: "log", body: renderLogTailToon(sections.log ?? ""), fenced: true, fenceLang: "toon" });
    if (sections.base !== undefined) out.push({ name: "base", body: sections.base });
  }

  // Hooks block sits last across every status except discarded; skipped when
  // no user hook ran (empty hooks body).
  if (status !== "discarded" && sections.hooks) {
    out.push({ name: "hooks", body: sections.hooks });
  }
  return out;
}

export function renderLogTailToon(log: string): string {
  const records = parseLane(log);
  if (records.length > 0) return encode(records as unknown as JsonValue);
  return encode({ tail: log } as JsonValue);
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
  /** Optional human-facing metadata lookup for refs in envelope notes. */
  issueReference?: IssueReferenceLookup;
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
  /** Legacy ADR 0103 field; ignored. */
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
  /** Always false; ADR 0103 removed failure snapshot pushes. */
  pushed: boolean;
  /** Always empty; ADR 0103 removed failure snapshot refs. */
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
 *   2. On a terminal FAILURE: write the failure.reason + envelope.ref markers
 *      regardless of the post outcome (they feed the next RUN, not the thread).
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

  // --- failure marker (step 2) ---
  let remoteBranch = "";
  let pushed = false;
  let markers: FailureMarkers = {};
  if (isFailure) {
    markers = buildFailureMarkers(summary, envelopeReference(input.repo, input.issue));
    await deps.writeMarkers(markers);
  }

  // --- compose body (steps 3) ---
  const sections = { ...(input.sections ?? {}) };
  if (sections.notes !== undefined) {
    sections.notes = await enrichIssueReferences(sections.notes, deps.issueReference);
  }
  const sectionList = buildSections(
    input.status,
    sections,
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
