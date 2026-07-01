import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LogLineCursor {
  size: number;
  lines: number;
}

export type LogLineCursorStore = Record<string, LogLineCursor>;

export interface LogLineCount {
  lines: number;
  newLines: number;
}

function validCursor(value: unknown): LogLineCursor | null {
  if (value === null || typeof value !== "object") return null;
  const rec = value as { size?: unknown; lines?: unknown };
  const size = Number(rec.size);
  const lines = Number(rec.lines);
  if (!Number.isFinite(size) || size < 0) return null;
  if (!Number.isFinite(lines) || lines < 0) return null;
  return { size, lines };
}

export async function readLogLineCursors(path: string): Promise<LogLineCursorStore> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
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
  await writeFile(tmp, `${JSON.stringify(cursors)}\n`, "utf8");
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
