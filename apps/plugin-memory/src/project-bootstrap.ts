import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import type { MemoryStore } from "./graph-store.js";
import { contentHash } from "./hash.js";
import { indexFile } from "./ingest.js";

const execFileAsync = promisify(execFile);

export interface ProjectBootstrapOptions {
  rootDir: string;
  dryRun?: boolean;
  maxFiles?: number;
  includeGitLog?: boolean;
  now?: number;
}

export interface ProjectBootstrapSource {
  path: string;
  kind: "readme" | "docs" | "adr" | "context" | "agent-rules" | "git-log";
  bytes: number;
  indexed: boolean;
  nodes: number;
  edges: number;
  docs: number;
  reason?: string;
}

export interface ProjectBootstrapReport {
  schema_version: "memory.project_bootstrap.v1";
  read_only: boolean;
  root: string;
  generated_at: string;
  dry_run: boolean;
  summary: {
    discovered_sources: number;
    indexed_sources: number;
    docs: number;
    nodes: number;
    edges: number;
    skipped: number;
  };
  sources: ProjectBootstrapSource[];
  recommended_next_actions: string[];
}

interface Candidate {
  path: string;
  kind: ProjectBootstrapSource["kind"];
}

export async function bootstrapProjectMemory(
  store: MemoryStore,
  opts: ProjectBootstrapOptions,
): Promise<ProjectBootstrapReport> {
  const root = resolve(opts.rootDir);
  const candidates = await discoverBootstrapSources(root, {
    maxFiles: opts.maxFiles,
    includeGitLog: opts.includeGitLog,
  });
  const sources: ProjectBootstrapSource[] = [];

  for (const candidate of candidates) {
    if (candidate.kind === "git-log") {
      sources.push(await bootstrapGitLog(store, root, candidate.path, opts));
      continue;
    }
    sources.push(await bootstrapFile(store, root, candidate, opts));
  }

  const summary = summarize(sources);
  return {
    schema_version: "memory.project_bootstrap.v1",
    read_only: opts.dryRun === true,
    root,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    dry_run: opts.dryRun === true,
    summary,
    sources,
    recommended_next_actions: recommendedActions(summary, opts),
  };
}

export async function discoverBootstrapSources(
  rootDir: string,
  opts: { maxFiles?: number; includeGitLog?: boolean } = {},
): Promise<Candidate[]> {
  const patterns = [
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/**/*.md",
    ".red/CONTEXT.md",
    ".red/contexts/**/*.md",
    ".red/adr/*.md",
  ];
  const files = await fg(patterns, {
    cwd: rootDir,
    absolute: true,
    onlyFiles: true,
    dot: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"],
  });
  const sorted = [...new Set(files)]
    .sort((a, b) => sourceRank(rootDir, a) - sourceRank(rootDir, b) || a.localeCompare(b))
    .slice(0, opts.maxFiles);
  const candidates = sorted.map((path) => ({ path, kind: sourceKind(rootDir, path) }));
  if (opts.includeGitLog === true) {
    candidates.push({ path: "git:log", kind: "git-log" });
  }
  return candidates;
}

async function bootstrapFile(
  store: MemoryStore,
  root: string,
  candidate: Candidate,
  opts: ProjectBootstrapOptions,
): Promise<ProjectBootstrapSource> {
  const bytes = await fileBytes(candidate.path);
  if (opts.dryRun === true) {
    return {
      path: relative(root, candidate.path),
      kind: candidate.kind,
      bytes,
      indexed: false,
      nodes: 0,
      edges: 0,
      docs: 0,
      reason: "dry-run",
    };
  }
  const report = await indexFile(store, candidate.path);
  return {
    path: relative(root, candidate.path),
    kind: candidate.kind,
    bytes,
    indexed: true,
    nodes: report.nodes,
    edges: report.edges,
    docs: report.docs,
  };
}

async function bootstrapGitLog(
  store: MemoryStore,
  root: string,
  path: string,
  opts: ProjectBootstrapOptions,
): Promise<ProjectBootstrapSource> {
  const log = await readGitLog(root);
  if (!log) {
    return {
      path,
      kind: "git-log",
      bytes: 0,
      indexed: false,
      nodes: 0,
      edges: 0,
      docs: 0,
      reason: "git log unavailable",
    };
  }
  const bytes = Buffer.byteLength(log, "utf8");
  if (opts.dryRun === true) {
    return {
      path,
      kind: "git-log",
      bytes,
      indexed: false,
      nodes: 0,
      edges: 0,
      docs: 0,
      reason: "dry-run",
    };
  }

  const title = `Recent git history for ${basename(root)}`;
  const hash = contentHash(path, log);
  await store.upsertDoc({
    path,
    title,
    body: log,
    frontmatter: { source: "git log", bootstrap: true },
    hash,
    updated_at: opts.now ?? Date.now(),
  });
  await store.upsertNode({
    label: "bootstrap:git-log",
    node_type: "concept",
    properties: {
      title,
      content: log,
      tags: ["bootstrap", "git-log", "project-history"],
      source: path,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "memory bootstrap",
        command: "git log --oneline --decorate --max-count=30",
      },
      hash,
      updated_at: opts.now ?? Date.now(),
    },
  });
  return { path, kind: "git-log", bytes, indexed: true, nodes: 1, edges: 0, docs: 1 };
}

async function readGitLog(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--oneline", "--decorate", "--max-count=30"],
      { cwd: root, encoding: "utf8" },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

function sourceKind(root: string, path: string): Candidate["kind"] {
  const rel = relative(root, path).replaceAll("\\", "/");
  if (/^readme\.md$/i.test(rel)) return "readme";
  if (rel === "AGENTS.md" || rel === "CLAUDE.md") return "agent-rules";
  if (rel.startsWith(".red/adr/")) return "adr";
  if (rel === ".red/CONTEXT.md" || rel.startsWith(".red/contexts/")) return "context";
  return "docs";
}

function sourceRank(root: string, path: string): number {
  const kind = sourceKind(root, path);
  return {
    readme: 0,
    "agent-rules": 1,
    context: 2,
    adr: 3,
    docs: 4,
    "git-log": 5,
  }[kind];
}

function summarize(sources: ProjectBootstrapSource[]): ProjectBootstrapReport["summary"] {
  return {
    discovered_sources: sources.length,
    indexed_sources: sources.filter((source) => source.indexed).length,
    docs: sources.reduce((sum, source) => sum + source.docs, 0),
    nodes: sources.reduce((sum, source) => sum + source.nodes, 0),
    edges: sources.reduce((sum, source) => sum + source.edges, 0),
    skipped: sources.filter((source) => !source.indexed).length,
  };
}

function recommendedActions(
  summary: ProjectBootstrapReport["summary"],
  opts: ProjectBootstrapOptions,
): string[] {
  if (summary.discovered_sources === 0) {
    return ["add README.md, docs/*.md, .red/CONTEXT.md, or .red/adr/*.md before bootstrapping Memory"];
  }
  if (opts.dryRun === true) {
    return ["rerun without --dry-run to seed RedDB Memory from the discovered project context"];
  }
  const actions = ["run `memory docs coverage --json` to verify graph grounding after bootstrap"];
  if (opts.includeGitLog !== true) {
    actions.push("rerun with --include-git-log when recent commit history should become Memory evidence");
  }
  return actions;
}
