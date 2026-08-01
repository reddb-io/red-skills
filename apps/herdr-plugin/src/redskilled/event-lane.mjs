/**
 * event-lane — the daemon's own memory, read from disk.
 *
 * ADR 0130 rule 8: birth, death and budget-kill are appended to a TOONL lane so
 * an incident can be read after the fact. The socket answers "what is running
 * NOW"; this file is the only surface that answers "what happened". A dashboard
 * without it can show a Worker vanish and never say whether it exited 0, was
 * killed over budget, or died with the daemon.
 *
 * **Tolerant on purpose.** The lane is written by a version of the daemon this
 * plugin does not ship with, so the reader sniffs JSON first, decodes TOONL when
 * it recognises a segment header, and keeps an undecodable line as raw text
 * rather than dropping it. A viewer that silently swallowed lines it could not
 * parse would report a quiet incident during exactly the format change that
 * caused it.
 */
import { open, readFile, stat } from "node:fs/promises";

/** How much of the tail to read when the lane is long. */
export const DEFAULT_EVENT_LANE_TAIL_BYTES = 256 * 1024;

const HEADER = /^\s*(?:#([A-Za-z0-9_.:-]+)\s*)?(?:\[[^\]]*\])?\{([^}]*)\}\s*:\s*$/;
const TRAILER = /^\s*\[=\d+\]\s*$/;

/**
 * Split one TOONL row into cells, honouring double-quoted cells. PURE.
 *
 * Quoting is the only structure a row has, so it is the only structure this
 * splitter knows: everything else is handed back as text and coerced later.
 */
export function splitRow(line, delimiter = ",") {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\\" && index + 1 < line.length) {
        cell += line[index + 1];
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/** A cell as the value it denotes; anything unrecognised stays the string. PURE. */
function coerce(raw) {
  const value = raw.trim();
  if (value === "" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return raw;
}

/**
 * Decode a lane's text into records, oldest first. PURE.
 *
 * Segment rotation is followed rather than assumed away: a fresh daemon process
 * re-declares the header, so one lane holds several segments and a reader locked
 * to the first header would decode every later row against the wrong fields.
 */
export function parseEventLane(raw) {
  const records = [];
  let fields = null;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    if (TRAILER.test(line)) continue;

    const header = HEADER.exec(line);
    if (header) {
      fields = header[2].split(",").map((field) => field.trim());
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        records.push({ ...JSON.parse(trimmed), _raw: line });
        continue;
      } catch {
        // Not JSON after all — fall through and try the row decoder.
      }
    }

    if (fields == null) {
      records.push({ _raw: line, _undecoded: true });
      continue;
    }

    const cells = splitRow(trimmed);
    const record = { _raw: line };
    fields.forEach((field, index) => {
      record[field] = index < cells.length ? coerce(cells[index]) : null;
    });
    records.push(record);
  }
  return records;
}

/** True when a record is one of the three facts the lane carries. PURE. */
export function isHostEvent(record) {
  return (
    record != null &&
    typeof record.ts === "string" &&
    typeof record.worker_id === "string" &&
    (record.event === "worker-birth" || record.event === "worker-death" || record.event === "worker-budget-kill")
  );
}

/**
 * The lane's last records, newest last; an absent lane is an empty history.
 *
 * Only the tail is read. A lane that has been appended to for a week is not a
 * reason to make every dashboard refresh pay for the whole session's history,
 * and the first partial line the window cuts is dropped rather than decoded — a
 * half-read row is not a record, it is the beginning of one.
 */
export async function readEventLane(path, { tailBytes = DEFAULT_EVENT_LANE_TAIL_BYTES, limit = 500 } = {}) {
  let size;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (error.code === "ENOENT") return { path, exists: false, records: [], truncated: false };
    throw error;
  }

  let raw;
  let truncated = false;
  if (size <= tailBytes) {
    raw = await readFile(path, "utf8");
  } else {
    const handle = await open(path, "r");
    try {
      const chunk = Buffer.alloc(tailBytes);
      await handle.read(chunk, 0, tailBytes, size - tailBytes);
      const text = chunk.toString("utf8");
      const newline = text.indexOf("\n");
      raw = newline < 0 ? text : text.slice(newline + 1);
      truncated = true;
    } finally {
      await handle.close();
    }
  }

  // A window into the middle of a lane usually opens after the segment header,
  // so rows decode against no fields and arrive as raw text. That is the honest
  // outcome — the alternative is inventing a schema the writer never declared.
  const records = parseEventLane(raw);
  return {
    path,
    exists: true,
    truncated,
    records: records.slice(Math.max(0, records.length - limit)),
  };
}
