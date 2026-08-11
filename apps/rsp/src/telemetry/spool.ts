import { randomUUID, createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import {
  DEFAULT_LANE_RETENTION_TARGET_RATIO,
  LANE_RETENTION_REGISTRY,
  laneOverCeilingSync,
  replaceLaneAtomicallySync,
  type LaneRetentionPolicy,
} from "@reddb-io/shared/lane-retention.js";
import { encodeLines, parseRecords, type ToonlLineEmitter } from "@reddb-io/toon";
import {
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  RSP_TELEMETRY_LEGACY_SPOOL_FILE,
  RSP_TELEMETRY_SPOOL_CORRECTIONS_FILE,
  RSP_TELEMETRY_SPOOL_FILE,
  type RspTelemetryEvent,
} from "./schema.js";
import { isRecord, numeric } from "./helpers.js";

const SPOOL_TEXT_INLINE_CAP_BYTES = 64 * 1024;
interface RspTelemetryCorrectionRow {
  correction_id: string;
  target_spool_id: string;
  action: "retry" | "resolved";
  created_at: string;
  event_json?: string;
}

interface RspTelemetrySpoolEntry {
  spool_id: string;
  event?: RspTelemetryEvent;
  raw_line?: string;
}

type FlatToonlRecord = Record<string, string | number | boolean | null>;

/**
 * Walk up from startDir to find the first directory that already contains a
 * `.red` child. Returns the repo root if found, null otherwise.
 *
 * Never creates or modifies the filesystem — only existsSync probes. Safe for
 * deleted paths because path.resolve() is string-only and existsSync returns
 * false (never throws) for absent entries. This upholds ADR 0067: rsp never
 * mints a `.red/` directory; if none is found in the hierarchy, the caller
 * must drop the telemetry event.
 */
function resolveRootForTelemetryWrite(startDir: string): string | null {
  if (!startDir) return null;
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".red"))) return current;
    const parent = resolve(join(current, ".."));
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function telemetrySpoolPath(rootDir: string): string {
  return join(rspStateDir(rootDir), RSP_TELEMETRY_SPOOL_FILE);
}

export function telemetryLegacySpoolPath(rootDir: string): string {
  return join(rspStateDir(rootDir), RSP_TELEMETRY_LEGACY_SPOOL_FILE);
}

export function telemetrySpoolCorrectionsPath(rootDir: string): string {
  return join(rspStateDir(rootDir), RSP_TELEMETRY_SPOOL_CORRECTIONS_FILE);
}

export async function appendTelemetryEvent(
  rootDir: string,
  event: RspTelemetryEvent,
  retention: LaneRetentionPolicy = LANE_RETENTION_REGISTRY["rsp-telemetry-spool"],
): Promise<void> {
  appendTelemetryEventSync(rootDir, event, retention);
}

export interface AppendTelemetryEventSyncOptions {
  /** Test seam for posing a drain rename immediately after an append. */
  readonly afterWrite?: (path: string, attempt: number) => void;
}

export function appendTelemetryEventSync(
  rootDir: string,
  event: RspTelemetryEvent,
  retention: LaneRetentionPolicy = LANE_RETENTION_REGISTRY["rsp-telemetry-spool"],
  options: AppendTelemetryEventSyncOptions = {},
): void {
  try {
    const resolvedRoot = resolveRootForTelemetryWrite(rootDir);
    if (!resolvedRoot) return;
    const path = telemetrySpoolPath(resolvedRoot);
    mkdirSync(dirname(path), { recursive: true });
    const line = formatSpoolRow({
      spool_id: randomUUID(),
      event: compactTelemetryEventForSpool(event),
    });
    const droppedBytes = trimLaneBeforeAppend(
      path,
      line,
      retention,
      parseSpoolEntries,
      formatSpoolRow,
    );
    appendSpoolLineSync(path, line, options);
    if (droppedBytes > 0) appendRetentionCorrection(resolvedRoot, "telemetry spool retention", droppedBytes);
  } catch {}
}

/**
 * Append to the active inode, then prove it is still the inode at the active
 * path. A drainer can rename between open and write; retrying the same spool id
 * makes that race at-least-once rather than silently lossy.
 */
function appendSpoolLineSync(
  path: string,
  line: string,
  options: AppendTelemetryEventSyncOptions,
): void {
  let attempt = 0;
  while (true) {
    const descriptor = openSync(path, "a", 0o600);
    try {
      writeSync(descriptor, line, undefined, "utf8");
      attempt += 1;
      options.afterWrite?.(path, attempt);
      const opened = fstatSync(descriptor);
      const active = statSync(path);
      if (opened.dev === active.dev && opened.ino === active.ino) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      closeSync(descriptor);
    }
  }
}

function compactTelemetryEventForSpool(event: RspTelemetryEvent): RspTelemetryEvent {
  return compactTextField(compactTextField(event, "raw_text", "raw_bytes"), "emitted_text", "emitted_bytes");
}

function compactTextField(
  event: RspTelemetryEvent,
  textField: "raw_text" | "emitted_text",
  bytesField: "raw_bytes" | "emitted_bytes",
): RspTelemetryEvent {
  const text = event[textField];
  if (typeof text !== "string") return event;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= SPOOL_TEXT_INLINE_CAP_BYTES) return event;
  const next = { ...event };
  delete next[textField];
  if (numeric(next[bytesField]) === 0) next[bytesField] = bytes;
  next.estimated = true;
  return next;
}

export async function takeTelemetrySpool(rootDir: string): Promise<string[]> {
  const resolvedRoot = resolveRootForTelemetryWrite(rootDir);
  if (!resolvedRoot) return [];
  const path = telemetrySpoolPath(resolvedRoot);
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  const files = await renameActiveSpools(resolvedRoot);
  const entries = [
    ...await readPendingCorrectionEntries(resolvedRoot),
    ...await readDrainEntries(files),
  ];
  await Promise.all(files.map((file) => rm(file, { force: true })));
  return entries.map((entry) => JSON.stringify(entry.event));
}

export async function drainTelemetrySpool(
  rootDir: string,
  drainLine: (line: string) => Promise<boolean>,
): Promise<void> {
  const resolvedRoot = resolveRootForTelemetryWrite(rootDir);
  if (!resolvedRoot) return;
  const path = telemetrySpoolPath(resolvedRoot);
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await ensureActiveSpoolFiles(resolvedRoot);

  for (const orphan of await orphanedDrainFiles(resolvedRoot)) {
    await drainFile(resolvedRoot, orphan, drainLine);
  }

  for (const entry of await readPendingCorrectionEntries(resolvedRoot)) {
    await drainEntry(resolvedRoot, entry, drainLine, true);
  }

  for (const drainingPath of await renameActiveSpools(resolvedRoot)) {
    await drainFile(resolvedRoot, drainingPath, drainLine);
  }
}

/**
 * A crash between the spool rename and the ingest leaves a `<spool>.<pid>.<ts>.drain` file behind.
 * Adopt those leftovers, skipping any still owned by a live process other than us.
 */
async function orphanedDrainFiles(rootDir: string): Promise<string[]> {
  const spoolPaths = [telemetrySpoolPath(rootDir), telemetryLegacySpoolPath(rootDir)];
  const dir = dirname(spoolPaths[0]!);
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) =>
    spoolPaths.some((spoolPath) => name.startsWith(`${basename(spoolPath)}.`) && name.endsWith(".drain"))
  )
    .filter((name) => {
      const base = spoolPaths.find((spoolPath) => name.startsWith(`${basename(spoolPath)}.`));
      if (!base) return false;
      const prefix = `${basename(base)}.`;
      const pid = Number(name.slice(prefix.length).split(".")[0]);
      return !(Number.isInteger(pid) && pid !== process.pid && isProcessAlive(pid));
    })
    .sort()
    .map((name) => join(dir, name));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function drainFile(
  rootDir: string,
  drainingPath: string,
  drainLine: (line: string) => Promise<boolean>,
): Promise<void> {
  try {
    const text = await readSettledFile(drainingPath);
    for (const entry of parseSpoolEntries(text)) {
      await drainEntry(rootDir, entry, drainLine, false);
    }
  } finally {
    await rm(drainingPath, { force: true });
  }
}

async function drainEntry(
  rootDir: string,
  entry: RspTelemetrySpoolEntry,
  drainLine: (line: string) => Promise<boolean>,
  fromCorrection: boolean,
): Promise<void> {
  const line = entry.event ? JSON.stringify(entry.event) : entry.raw_line ?? "";
  try {
    if (await drainLine(line)) {
      if (fromCorrection) {
        appendCorrection(rootDir, {
          correction_id: randomUUID(),
          target_spool_id: entry.spool_id,
          action: "resolved",
          created_at: new Date().toISOString(),
        });
      }
      return;
    }
  } catch {}
  appendCorrection(rootDir, {
    correction_id: randomUUID(),
    target_spool_id: entry.spool_id,
    action: "retry",
    created_at: new Date().toISOString(),
    event_json: entry.event ? JSON.stringify(entry.event) : undefined,
  });
}

async function readSettledFile(path: string): Promise<string> {
  let text = "";
  for (let i = 0; i < 5; i++) {
    const next = await readFile(path, "utf8").catch(() => "");
    if (next === text) return next;
    text = next;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return text;
}

export function parseTelemetryEvent(line: string): RspTelemetryEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    if (
      parsed.collection !== RSP_ACCOUNTING_EVENTS_COLLECTION &&
      parsed.collection !== RSP_DECISIONS_COLLECTION &&
      parsed.collection !== RSP_TELEMETRY_INVOCATIONS_COLLECTION &&
      parsed.collection !== RSP_TELEMETRY_DEGRADATIONS_COLLECTION
    ) return null;
    return parsed as RspTelemetryEvent;
  } catch {
    return null;
  }
}

function formatSpoolRow(row: RspTelemetrySpoolEntry): string {
  const spoolEmitter: ToonlLineEmitter = encodeLines();
  return spoolEmitter.push(spoolEntryToToonlRow(row));
}

function appendCorrection(rootDir: string, correction: RspTelemetryCorrectionRow, reportRetention = true): void {
  try {
    const resolvedRoot = resolveRootForTelemetryWrite(rootDir);
    if (!resolvedRoot) return;
    const path = telemetrySpoolCorrectionsPath(resolvedRoot);
    mkdirSync(dirname(path), { recursive: true });
    const line = formatCorrectionRow(correction);
    const droppedBytes = trimLaneBeforeAppend(
      path,
      line,
      LANE_RETENTION_REGISTRY["rsp-telemetry-corrections"],
      parseCorrectionRows,
      formatCorrectionRow,
    );
    appendFileSync(path, line, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (reportRetention && droppedBytes > 0) {
      appendRetentionCorrection(resolvedRoot, "telemetry corrections retention", droppedBytes, false);
    }
  } catch {}
}

function appendRetentionCorrection(
  rootDir: string,
  reason: string,
  bytes: number,
  reportRetention = true,
): void {
  const spoolId = randomUUID();
  appendCorrection(rootDir, {
    correction_id: randomUUID(),
    target_spool_id: spoolId,
    action: "retry",
    created_at: new Date().toISOString(),
    event_json: JSON.stringify({
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      id: spoolId,
      created_at: new Date().toISOString(),
      reason,
      bytes,
    } satisfies RspTelemetryEvent),
  }, reportRetention);
}

function formatCorrectionRow(correction: RspTelemetryCorrectionRow): string {
  const correctionEmitter: ToonlLineEmitter = encodeLines();
  return correctionEmitter.push({
    correction_id: correction.correction_id,
    target_spool_id: correction.target_spool_id,
    action: correction.action,
    created_at: correction.created_at,
    event_json: correction.event_json ?? null,
  });
}

function trimLaneBeforeAppend<Row>(
  path: string,
  incoming: string,
  policy: LaneRetentionPolicy,
  parse: (text: string) => Row[],
  format: (row: Row) => string,
): number {
  const incomingBytes = Buffer.byteLength(incoming);
  if (!laneOverCeilingSync(path, incomingBytes, policy)) return 0;

  let original: string;
  try {
    original = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  const maxBytes = policy.maxBytes;
  if (maxBytes === undefined) return 0;
  const targetBytes = Math.max(
    0,
    Math.floor(maxBytes * (policy.targetRatio ?? DEFAULT_LANE_RETENTION_TARGET_RATIO)) - incomingBytes,
  );
  const rows = parse(original);
  const kept: string[] = [];
  let keptBytes = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const encoded = format(rows[index]!);
    const encodedBytes = Buffer.byteLength(encoded);
    if (keptBytes + encodedBytes > targetBytes) break;
    kept.unshift(encoded);
    keptBytes += encodedBytes;
  }
  const replacement = kept.join("");
  replaceLaneAtomicallySync(path, replacement);
  return Math.max(0, Buffer.byteLength(original) - Buffer.byteLength(replacement));
}

async function renameActiveSpools(rootDir: string): Promise<string[]> {
  const paths = [telemetrySpoolPath(rootDir), telemetryLegacySpoolPath(rootDir)];
  const renamed: string[] = [];
  for (const path of paths) {
    const drainingPath = `${path}.${process.pid}.${Date.now()}.drain`;
    try {
      await rename(path, drainingPath);
      await writeFile(path, "", { flag: "wx" }).catch(() => undefined);
      renamed.push(drainingPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
  }
  return renamed;
}

async function ensureActiveSpoolFiles(rootDir: string): Promise<void> {
  await Promise.all([
    writeFile(telemetrySpoolPath(rootDir), "", { flag: "a" }),
    writeFile(telemetryLegacySpoolPath(rootDir), "", { flag: "a" }),
  ]).catch(() => undefined);
}

async function readDrainEntries(paths: readonly string[]): Promise<RspTelemetrySpoolEntry[]> {
  const entries: RspTelemetrySpoolEntry[] = [];
  for (const path of paths) {
    entries.push(...parseSpoolEntries(await readSettledFile(path)));
  }
  return entries;
}

async function readPendingCorrectionEntries(rootDir: string): Promise<RspTelemetrySpoolEntry[]> {
  const text = await readFile(telemetrySpoolCorrectionsPath(rootDir), "utf8").catch(() => "");
  const latest = new Map<string, RspTelemetryCorrectionRow>();
  for (const row of parseCorrectionRows(text)) latest.set(row.target_spool_id, row);
  return [...latest.values()]
    .filter((row) => row.action === "retry" && row.event_json)
    .map((row) => ({ spool_id: row.target_spool_id, event: parseTelemetryEvent(row.event_json!) ?? undefined }))
    .filter((entry) => entry.event !== undefined);
}

function parseSpoolEntries(text: string): RspTelemetrySpoolEntry[] {
  const entries: RspTelemetrySpoolEntry[] = [];
  let header = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) {
        const event = parseTelemetryEvent(JSON.stringify(parsed));
        entries.push(event
          ? { spool_id: legacySpoolId(JSON.stringify(parsed)), event }
          : { spool_id: legacySpoolId(line), raw_line: line });
      }
      continue;
    } catch {}
    if (/^\[(?:\d*)\]\{[^}]+\}:$/.test(line)) {
      header = line;
      continue;
    }
    if (!header) {
      entries.push({ spool_id: legacySpoolId(line), raw_line: line });
      continue;
    }
    try {
      for (const row of parseRecords(`${header}\n${line}\n`)) {
        if (isFlatToonlRecord(row) && isSpoolRow(row)) {
          entries.push({ spool_id: row.spool_id, event: eventFromSpoolRow(row)! });
        }
      }
    } catch {
      if (line.startsWith("{")) entries.push({ spool_id: legacySpoolId(line), raw_line: line });
    }
  }
  return entries;
}

function parseCorrectionRows(text: string): RspTelemetryCorrectionRow[] {
  return parseSniffedRecords(text).map(toCorrectionRow).filter((row): row is RspTelemetryCorrectionRow => row !== null);
}

function parseSniffedRecords(text: string): FlatToonlRecord[] {
  const records: FlatToonlRecord[] = [];
  let header = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isFlatToonlRecord(parsed)) records.push(parsed);
    } catch {
      if (/^\[(?:\d*)\]\{[^}]+\}:$/.test(line)) {
        header = line;
        continue;
      }
      if (!header) continue;
      try {
        for (const rec of parseRecords(`${header}\n${line}\n`)) {
          if (isFlatToonlRecord(rec)) records.push(rec);
        }
      } catch {}
    }
  }
  return records;
}

function legacySpoolId(line: string): string {
  return `legacy:${createHash("sha256").update(line).digest("hex").slice(0, 24)}`;
}

function spoolEntryToToonlRow(entry: RspTelemetrySpoolEntry): FlatToonlRecord {
  const row: FlatToonlRecord = { spool_id: entry.spool_id };
  for (const [key, value] of Object.entries(entry.event ?? {})) {
    if (key === "spool_id") continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      row[key] = value;
    } else if (value !== undefined) {
      row[key] = JSON.stringify(value);
    }
  }
  return row;
}

function eventFromSpoolRow(row: FlatToonlRecord): RspTelemetryEvent | null {
  const { spool_id: _spoolId, ...event } = row;
  return parseTelemetryEvent(JSON.stringify(event));
}

function isSpoolRow(value: FlatToonlRecord): value is FlatToonlRecord & { spool_id: string } {
  return typeof value.spool_id === "string" && eventFromSpoolRow(value) !== null;
}

function toCorrectionRow(value: FlatToonlRecord): RspTelemetryCorrectionRow | null {
  if (
    typeof value.correction_id === "string" &&
    typeof value.target_spool_id === "string" &&
    (value.action === "retry" || value.action === "resolved") &&
    typeof value.created_at === "string" &&
    (value.event_json === null || typeof value.event_json === "string")
  ) {
    return {
      correction_id: value.correction_id,
      target_spool_id: value.target_spool_id,
      action: value.action,
      created_at: value.created_at,
      event_json: value.event_json ?? undefined,
    };
  }
  return null;
}

function isFlatToonlRecord(value: unknown): value is FlatToonlRecord {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) =>
    typeof entry === "string" ||
    typeof entry === "number" ||
    typeof entry === "boolean" ||
    entry === null
  );
}
