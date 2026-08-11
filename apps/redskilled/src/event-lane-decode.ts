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

import { parseRecords } from "@reddb-io/toon";

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
