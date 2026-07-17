import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import { appendTelemetryEvent, RSP_DECISIONS_COLLECTION } from "./telemetry.js";

export interface GhConditionalRequest {
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  cwd?: string;
  telemetryRoot?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
}

export interface GhConditionalResult {
  status: number;
  stdout: string;
  stderr: string;
  etag?: string;
  quotaFree: boolean;
}

interface GhEtagCacheDocument {
  version: 1;
  entries: Record<string, GhEtagCacheEntry>;
}

interface GhEtagCacheEntry {
  key: string;
  request: string;
  etag: string;
  body: string;
  updated_at: string;
}

const CACHE_FILE = "gh-etag-cache.json";

export async function readGhConditionalJson(request: GhConditionalRequest): Promise<GhConditionalResult> {
  const cwd = request.cwd ?? process.cwd();
  const telemetryRoot = request.telemetryRoot ?? cwd;
  const identity = requestIdentity(request.path, request.params);
  const key = cacheKey(identity);
  const cache = await readCache(telemetryRoot);
  const cached = cache.entries[key];
  const args = ["api", "--include", "--method", "GET", request.path];
  for (const [name, value] of sortedParams(request.params)) {
    args.push("-f", `${name}=${String(value)}`);
  }
  if (cached?.etag) args.push("-H", `If-None-Match: ${cached.etag}`);

  const result = await runGh(args, cwd, request.env);
  const parsed = parseIncludedResponse(result.stdout);
  const quotaFree = parsed.statusCode === 304 && !!cached;
  if (quotaFree) {
    await recordConditionalTelemetry(telemetryRoot, request.command ?? `gh api ${request.path}`, true);
    return {
      status: 0,
      stdout: cached.body,
      stderr: result.stderr,
      etag: cached.etag,
      quotaFree: true,
    };
  }

  if (parsed.statusCode >= 200 && parsed.statusCode < 300) {
    const etag = parsed.headers.get("etag");
    if (etag) {
      cache.entries[key] = {
        key,
        request: identity,
        etag,
        body: parsed.body,
        updated_at: new Date().toISOString(),
      };
      await writeCache(telemetryRoot, cache);
    }
    await recordConditionalTelemetry(telemetryRoot, request.command ?? `gh api ${request.path}`, false);
    return {
      status: result.status,
      stdout: parsed.body,
      stderr: result.stderr,
      etag: etag ?? undefined,
      quotaFree: false,
    };
  }

  await recordConditionalTelemetry(telemetryRoot, request.command ?? `gh api ${request.path}`, false);
  return {
    status: result.status,
    stdout: parsed.body || result.stdout,
    stderr: result.stderr,
    quotaFree: false,
  };
}

function sortedParams(params: GhConditionalRequest["params"]): Array<[string, string | number | boolean]> {
  return Object.entries(params ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
}

function requestIdentity(path: string, params: GhConditionalRequest["params"]): string {
  return JSON.stringify({ method: "GET", path, params: sortedParams(params) });
}

function cacheKey(identity: string): string {
  return createHash("sha256").update(`rsp-gh-etag-v1\0${identity}`).digest("hex");
}

async function runGh(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<{ status: number; stdout: string; stderr: string }> {
  return await new Promise((resolveResult) => {
    const child = spawn("gh", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (err) => resolveResult({ status: 1, stdout: "", stderr: err.message }));
    child.once("close", (status) => {
      resolveResult({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

function parseIncludedResponse(raw: string): { statusCode: number; headers: Map<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const matches = [...normalized.matchAll(/^HTTP\/\S+\s+(\d{3})[^\n]*\n/gm)];
  if (matches.length === 0) return { statusCode: 0, headers: new Map(), body: raw };
  const last = matches[matches.length - 1]!;
  const statusCode = Number(last[1]);
  const headerStart = last.index! + last[0].length;
  const bodyStart = normalized.indexOf("\n\n", headerStart);
  const headerText = bodyStart >= 0 ? normalized.slice(headerStart, bodyStart) : normalized.slice(headerStart);
  const headers = new Map<string, string>();
  for (const line of headerText.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return {
    statusCode,
    headers,
    body: bodyStart >= 0 ? normalized.slice(bodyStart + 2) : "",
  };
}

async function readCache(root: string): Promise<GhEtagCacheDocument> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(root), "utf8")) as unknown;
    if (isCacheDocument(parsed)) return parsed;
  } catch {}
  return { version: 1, entries: {} };
}

async function writeCache(root: string, cache: GhEtagCacheDocument): Promise<void> {
  const path = cachePath(root);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function cachePath(root: string): string {
  return join(rspStateDir(root), CACHE_FILE);
}

async function recordConditionalTelemetry(root: string, command: string, quotaFree: boolean): Promise<void> {
  await appendTelemetryEvent(root, {
    collection: RSP_DECISIONS_COLLECTION,
    id: randomUUID(),
    created_at: new Date().toISOString(),
    command,
    command_family: "gh api",
    decision: "contributed",
    reason: quotaFree ? "gh-conditional-304" : "gh-conditional-fetch",
    quota_free: quotaFree,
    saved_units: quotaFree ? 1 : 0,
  });
}

function isCacheDocument(value: unknown): value is GhEtagCacheDocument {
  return isRecord(value) &&
    value.version === 1 &&
    isRecord(value.entries) &&
    Object.values(value.entries).every(isCacheEntry);
}

function isCacheEntry(value: unknown): value is GhEtagCacheEntry {
  return isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.request === "string" &&
    typeof value.etag === "string" &&
    typeof value.body === "string" &&
    typeof value.updated_at === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
