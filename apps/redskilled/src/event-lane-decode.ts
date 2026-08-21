/**
 * event-lane-decode — the tolerant row decoder for the host event lane.
 *
 * A canonical append-only lane outlives daemon generations, so it can hold rows
 * an older writer shaped differently (issue #3651: one 3.14.0 `demand-refusal`
 * row disagreed with its own header's arity and a strict reader died on it,
 * first killing dispatch, then wedging the daemon's own writer). A historical
 * row that fails to decode is skipped and counted — never fatal to a live
 * operation — and the skip is reported once, naming the lines, so a genuine
 * format bug still has a voice.
 */

import {
  isAttributionConfidence,
  isDeathSenderClass,
} from "@reddb-io/shared/death-attribution.js";
import { parseRecords } from "@reddb-io/toon";
import type { RedskilledEventKind, RedskilledHostEvent } from "./event-lane.js";

type ToonlRecord = Record<string, string | number | boolean | null>;

export interface RedskilledDecodedLane {
  readonly records: ToonlRecord[];
  /** 1-indexed lines whose rows no governing header could decode. */
  readonly malformed: number[];
}

/**
 * Decode lane lines into records, skipping rows their header cannot hold. PURE
 * over its input; the caller owns reporting the malformed count.
 */
export function decodeLaneRows(lines: readonly string[]): RedskilledDecodedLane {
  const records: ToonlRecord[] = [];
  const malformed: number[] = [];
  let header: string | null = null;
  for (const [index, line] of lines.entries()) {
    if (/^\[\d*\]\{.*\}:$/.test(line)) {
      header = line;
      continue;
    }
    if (header == null) {
      malformed.push(index + 1);
      continue;
    }
    try {
      records.push(...parseRecords(`${header}\n${line}\n`));
    } catch {
      malformed.push(index + 1);
    }
  }
  return { records, malformed };
}

/** Project one versioned lane row into the current total event shape. PURE. */
export function decodeHostEventRow(record: ToonlRecord): RedskilledHostEvent {
  const kind = (record.kind ?? record.event) as RedskilledEventKind;
  return {
    version: 1,
    ts: String(record.ts),
    kind,
    event: kind,
    worker_id: String(record.worker_id),
    project_label: text(record.project_label) ?? "",
    pid: Number(record.pid ?? 0),
    ...(record.pgid == null || record.pgid === "" ? {} : { pgid: Number(record.pgid) }),
    ...(text(record.proc_start_time) == null ? {} : { proc_start_time: text(record.proc_start_time)! }),
    workspace_path: text(record.workspace_path) ?? "",
    fork_sha: text(record.fork_sha),
    log_path: text(record.log_path),
    isolated: record.isolated === true || record.isolated === "true",
    unit: text(record.unit),
    memory_high: text(record.memory_high),
    memory_max: text(record.memory_max),
    cpu_weight: numberOrNull(record.cpu_weight),
    admission_verdict: text(record.admission_verdict),
    phase: text(record.phase),
    step: text(record.step),
    tokens: numberOrNull(record.tokens),
    tools: numberOrNull(record.tools),
    runner: text(record.runner),
    model: text(record.model),
    base_head_sha: text(record.base_head_sha),
    base_commits_ahead: numberOrNull(record.base_commits_ahead),
    heal_kind: text(record.heal_kind),
    failure_mode: text(record.failure_mode),
    detail: text(record.detail),
    // Legacy rows read exit facts as absent, never as a clean zero exit.
    exit_code: numberOrNull(record.exit_code),
    signal: text(record.signal),
    systemd_result: text(record.systemd_result),
    memory_peak_bytes: numberOrNull(record.memory_peak_bytes),
    memory_swap_peak_bytes: numberOrNull(record.memory_swap_peak_bytes),
    pids_peak: numberOrNull(record.pids_peak),
    journal_tail: text(record.journal_tail),
    // A row written before ADR 0155 carries no classification, and an absent
    // verdict must never decode as a confident one: the sweep that reads this
    // lane treats `null` as "nobody classified it" and leaves such a death to
    // the boot sweep, exactly as it behaved before the field existed.
    sender_class: isDeathSenderClass(record.sender_class) ? record.sender_class : null,
    confidence: isAttributionConfidence(record.confidence) ? record.confidence : null,
    // Legacy rows predate daemon stop reasons; absence remains honest.
    reason: text(record.reason),
  };
}

function text(value: ToonlRecord[string]): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function numberOrNull(value: ToonlRecord[string]): number | null {
  return value == null || value === "" ? null : Number(value);
}
