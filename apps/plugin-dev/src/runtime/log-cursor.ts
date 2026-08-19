import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parseLaneSinceCursor,
  ToonlCursorInvalidationError,
  type ToonlLaneCursor,
} from "../core/jsonl-log.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "../core/toon-snapshot.js";

export interface LogLineCursor {
  size: number;
  lines: number;
  toonl?: ToonlLaneCursor;
}

export type LogLineCursorStore = Record<string, LogLineCursor>;

export interface LogLineCount {
  lines: number;
  newLines: number;
}

function validCursor(value: unknown): LogLineCursor | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as { size?: unknown; lines?: unknown; toonl?: unknown };
  const size = Number(rec.size);
  const lines = Number(rec.lines);
  if (!Number.isFinite(size) || size < 0) return null;
  if (!Number.isFinite(lines) || lines < 0) return null;
  const out: LogLineCursor = { size, lines };
  if (rec.toonl !== null && typeof rec.toonl === "object") {
    const toonl = rec.toonl as Partial<ToonlLaneCursor>;
    const byteOffset = Number(toonl.byteOffset);
    const rowsSinceHeader = Number(toonl.rowsSinceHeader);
    if (Number.isFinite(byteOffset) && byteOffset >= 0 && Number.isFinite(rowsSinceHeader) && rowsSinceHeader >= 0) {
      out.toonl = {
        byteOffset,
        rowsSinceHeader,
        activeHeader: typeof toonl.activeHeader === "string" ? toonl.activeHeader : "",
        taggedHeaders:
          toonl.taggedHeaders !== null && typeof toonl.taggedHeaders === "object"
            ? Object.fromEntries(
                Object.entries(toonl.taggedHeaders as Record<string, unknown>)
                  .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
              )
            : {},
      };
    }
  }
  return out;
}

export async function readLogLineCursors(path: string): Promise<LogLineCursorStore> {
  try {
    // Sniff JSON-then-TOON so a cursor cache written by an older bundle still reads.
    const parsed = decodeDevSnapshotSniff(await readFile(path, "utf8")) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: LogLineCursorStore = {};
    for (const [logPath, value] of Object.entries(parsed)) {
      const cursor = validCursor(value);
      if (cursor !== null) out[logPath] = cursor;
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeLogLineCursors(path: string, cursors: LogLineCursorStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  // TOON, never raw JSON — the monitor log-cursor snapshot surface (ADR 0097).
  await writeFile(tmp, encodeDevSnapshotToon(cursors as unknown as Parameters<typeof encodeDevSnapshotToon>[0]), "utf8");
  await rename(tmp, path);
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

async function readUtf8Range(path: string, start: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, encoding: "utf8" });
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function countLogLinesSinceCursor(
  path: string,
  previous: LogLineCursor | undefined,
): Promise<{ count: LogLineCount; cursor: LogLineCursor } | null> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return null;
  }
  if (path.endsWith(".toonl") || path.endsWith(".jsonl")) {
    const text = await readFile(path, "utf8");
    let parsed: ReturnType<typeof parseLaneSinceCursor>;
    let reset = previous === undefined || size < previous.size || previous.toonl === undefined;
    const previousCursor = previous?.toonl;
    try {
      parsed = parseLaneSinceCursor(text, reset ? undefined : previousCursor);
    } catch (err) {
      if (!(err instanceof ToonlCursorInvalidationError)) throw err;
      reset = true;
      parsed = parseLaneSinceCursor(text);
    }
    const totalLines = reset ? parsed.records.length : (previous?.lines ?? 0) + parsed.records.length;
    return {
      count: { lines: totalLines, newLines: parsed.records.length },
      cursor: { size, lines: totalLines, toonl: parsed.cursor },
    };
  }

  const reset = previous === undefined || size < previous.size;
  const start = reset ? 0 : previous.size;
  const slice = size > start ? await readUtf8Range(path, start) : "";
  const newLines = countNewlines(slice);
  const totalLines = reset ? newLines : previous.lines + newLines;
  return {
    count: { lines: totalLines, newLines },
    cursor: { size, lines: totalLines },
  };
}

export async function collectLogLineCounts(
  cachePath: string,
  logPaths: readonly string[],
): Promise<Map<string, LogLineCount>> {
  const previous = await readLogLineCursors(cachePath);
  const next: LogLineCursorStore = {};
  const out = new Map<string, LogLineCount>();
  for (const logPath of logPaths) {
    const result = await countLogLinesSinceCursor(logPath, previous[logPath]);
    if (result === null) continue;
    out.set(logPath, result.count);
    next[logPath] = result.cursor;
  }
  await writeLogLineCursors(cachePath, next).catch(() => {});
  return out;
}
