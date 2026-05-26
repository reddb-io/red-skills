/**
 * Federation cross-root read — first vertical slice (issue #168).
 *
 * Reads markdown memory notes across multiple configured roots and returns a
 * merged, ranked list. No privacy policy is applied yet (issue #3b lands that);
 * every hit from every configured root is included verbatim and tagged with
 * `origin_repo`.
 *
 * Config: `.red/memory/federation.yaml` at the local repo root. Local-only in
 * this slice — git URLs are accepted in the schema as opaque strings but not
 * resolved.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { readConfig, resolveNotesDir } from "./config.js";
import { recall, type RecallHit } from "./recall.js";

export interface FederationRoot {
  /** Stable identifier surfaced as `origin_repo` on each merged result. */
  repo: string;
  /** Absolute or repo-root-relative filesystem path. */
  path: string;
}

export interface FederationConfig {
  roots: FederationRoot[];
}

export interface FederationResult {
  origin_repo: string;
  id: string;
  score: number;
  excerpt: string;
  path: string;
}

export interface FederationRootStatus {
  origin_repo: string;
  path: string;
  status: "ok" | "missing-config" | "missing-notes" | "error";
  hits: number;
  error?: string;
}

export interface FederationReport {
  schema_version: "memory.federation.v1";
  read_only: true;
  query: string;
  generated_at: string;
  limit: number;
  roots_queried: number;
  roots: FederationRootStatus[];
  results: FederationResult[];
}

export interface FederationOptions {
  limit?: number;
  perRootLimit?: number;
  now?: number;
  /** Override the config (skip yaml read) — primarily for tests. */
  config?: FederationConfig | null;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PER_ROOT_LIMIT = 10;

/** Absolute path to the federation config file for a repo root. */
export function federationConfigPath(rootDir: string): string {
  return resolve(rootDir, ".red/memory/federation.yaml");
}

/**
 * Read `.red/memory/federation.yaml`. Returns `null` when the file is missing
 * so the federation surface can return an empty report gracefully (AC: missing
 * config returns empty results gracefully).
 */
export async function loadFederationConfig(
  rootDir: string,
): Promise<FederationConfig | null> {
  let raw: string;
  try {
    raw = await readFile(federationConfigPath(rootDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseFederationYaml(raw);
}

/**
 * Minimal YAML parser tuned to the federation config shape — `roots:` followed
 * by a list of `- repo:` / `path:` blocks. Avoids pulling in a full YAML
 * dependency for this single-file format. Throws on malformed input so config
 * bugs surface immediately rather than silently degrading to empty results.
 */
export function parseFederationYaml(raw: string): FederationConfig {
  const lines = raw.split(/\r?\n/);
  const roots: FederationRoot[] = [];
  let inRoots = false;
  let current: Partial<FederationRoot> | null = null;

  const flush = () => {
    if (!current) return;
    if (typeof current.repo !== "string" || current.repo.length === 0) {
      throw new Error(`federation.yaml: root entry missing "repo"`);
    }
    if (typeof current.path !== "string" || current.path.length === 0) {
      throw new Error(`federation.yaml: root entry "${current.repo}" missing "path"`);
    }
    roots.push({ repo: current.repo, path: current.path });
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (line.trim().length === 0) continue;

    if (!inRoots) {
      if (/^roots\s*:\s*$/.test(line)) {
        inRoots = true;
      }
      continue;
    }

    const itemMatch = line.match(/^\s*-\s*(.*)$/);
    if (itemMatch) {
      flush();
      current = {};
      const after = itemMatch[1]?.trim() ?? "";
      if (after.length > 0) {
        applyKv(current, after);
      }
      continue;
    }

    if (current) {
      applyKv(current, line.trim());
    }
  }
  flush();

  return { roots };
}

function applyKv(target: Partial<FederationRoot>, fragment: string): void {
  const match = fragment.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
  if (!match) return;
  const key = match[1];
  const value = unquote((match[2] ?? "").trim());
  if (key === "repo") target.repo = value;
  else if (key === "path") target.path = value;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Compose a federation report by querying each configured root's markdown
 * memory notes and merging the results. Each hit carries `origin_repo` so the
 * caller can tell which root contributed it. Missing or misconfigured roots
 * are reported under `roots[]` with a non-`ok` status — they do not abort the
 * federation read (AC: graceful degradation).
 */
export async function buildFederationReport(
  rootDir: string,
  query: string,
  opts: FederationOptions = {},
): Promise<FederationReport> {
  const trimmedQuery = query.trim();
  const limit = clampLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const perRootLimit = clampLimit(opts.perRootLimit, DEFAULT_PER_ROOT_LIMIT, MAX_LIMIT);
  const generatedAt = new Date(opts.now ?? Date.now()).toISOString();

  const config =
    opts.config !== undefined ? opts.config : await loadFederationConfig(rootDir);

  if (!config || config.roots.length === 0 || trimmedQuery.length === 0) {
    return {
      schema_version: "memory.federation.v1",
      read_only: true,
      query: trimmedQuery,
      generated_at: generatedAt,
      limit,
      roots_queried: 0,
      roots: [],
      results: [],
    };
  }

  const rootStatuses: FederationRootStatus[] = [];
  const merged: FederationResult[] = [];

  for (const root of config.roots) {
    const absRoot = isAbsolute(root.path) ? root.path : resolve(rootDir, root.path);
    const status: FederationRootStatus = {
      origin_repo: root.repo,
      path: absRoot,
      status: "ok",
      hits: 0,
    };

    try {
      const cfg = await readConfig(absRoot);
      if (!cfg) {
        status.status = "missing-config";
        rootStatuses.push(status);
        continue;
      }
      const notesDir = resolveNotesDir(absRoot, cfg);
      const hits = await recall(notesDir, trimmedQuery, perRootLimit);
      for (const hit of hits) {
        merged.push(toFederationResult(root.repo, hit));
      }
      status.hits = hits.length;
      rootStatuses.push(status);
    } catch (err) {
      status.status = "error";
      status.error = err instanceof Error ? err.message : String(err);
      rootStatuses.push(status);
    }
  }

  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const repoCmp = a.origin_repo.localeCompare(b.origin_repo);
    if (repoCmp !== 0) return repoCmp;
    return a.id.localeCompare(b.id);
  });

  return {
    schema_version: "memory.federation.v1",
    read_only: true,
    query: trimmedQuery,
    generated_at: generatedAt,
    limit,
    roots_queried: config.roots.length,
    roots: rootStatuses,
    results: merged.slice(0, limit),
  };
}

function toFederationResult(originRepo: string, hit: RecallHit): FederationResult {
  return {
    origin_repo: originRepo,
    id: hit.id,
    score: hit.score,
    excerpt: hit.excerpt,
    path: hit.path,
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}
