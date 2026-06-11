import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { contentHash } from "./hash.js";
import type { EdgeLabel, MemoryNode } from "./schema.js";

export interface DevArtifactExtraction {
  nodes: MemoryNode[];
  edges: Array<{ fromLabel: string; toLabel: string; label: EdgeLabel }>;
}

interface WorkflowHit {
  id: string;
  title: string;
  kind: string;
  line: number;
  summary?: string;
}

interface ImportHit {
  id: string;
  title: string;
  kind: string;
}

export async function extractDevArtifact(path: string): Promise<DevArtifactExtraction> {
  if (!isDevArtifact(path)) return { nodes: [], edges: [] };
  const source = await readFile(path, "utf8");
  const language = languageForPath(path);
  const fileNode: MemoryNode = {
    label: `file:${path}`,
    node_type: "file",
    properties: {
      title: path,
      language,
      source: path,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-dev-artifact",
        confidence: "EXTRACTED",
        evidence: [path],
      },
      hash: contentHash(path, source),
    },
  };
  const workflows = extractWorkflows(path, source);
  const imports = extractImports(path, source);
  const workflowNodes = workflows.map<MemoryNode>((workflow) => ({
    label: `workflow:${path}#${workflow.id}`,
    node_type: "workflow",
    properties: {
      title: workflow.title,
      summary: workflow.summary ?? workflow.kind,
      source: `${path}:${workflow.line}`,
      language,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-dev-artifact",
        confidence: "EXTRACTED",
        evidence: [`${path}:${workflow.line}`],
      },
      hash: contentHash(path, "workflow", workflow.id, workflow.title),
      artifact_kind: workflow.kind,
    },
  }));
  const importNodes = imports.map<MemoryNode>((item) => ({
    label: `import:${path}#${item.id}`,
    node_type: "import",
    properties: {
      title: item.title,
      summary: item.kind,
      source: path,
      language,
      confidence: "EXTRACTED",
      provenance: {
        source_kind: "derived",
        writer: "extract-dev-artifact",
        confidence: "EXTRACTED",
        evidence: [path],
      },
      hash: contentHash(path, "import", item.kind, item.id),
      import_kind: item.kind,
    },
  }));
  const edges: DevArtifactExtraction["edges"] = [
    ...workflowNodes.map((node) => ({
      fromLabel: node.label,
      toLabel: fileNode.label,
      label: "DEFINED_IN" as const,
    })),
    ...importNodes.map((node) => ({
      fromLabel: fileNode.label,
      toLabel: node.label,
      label: "IMPORTS" as const,
    })),
  ];
  return { nodes: [fileNode, ...workflowNodes, ...importNodes], edges };
}

export function isDevArtifact(path: string): boolean {
  const name = basename(path).toLowerCase();
  const ext = extname(path).toLowerCase();
  return (
    name === "package.json" ||
    name === "dockerfile" ||
    name.endsWith(".dockerfile") ||
    path.includes("/.github/workflows/") && (ext === ".yml" || ext === ".yaml") ||
    ext === ".sh" ||
    ext === ".bash"
  );
}

function languageForPath(path: string): string {
  const name = basename(path).toLowerCase();
  const ext = extname(path).toLowerCase();
  if (name === "package.json") return "json";
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return "dockerfile";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".sh" || ext === ".bash") return "shell";
  return "dev-artifact";
}

function extractWorkflows(path: string, source: string): WorkflowHit[] {
  const name = basename(path).toLowerCase();
  if (name === "package.json") return packageScripts(source);
  if (name === "dockerfile" || name.endsWith(".dockerfile")) return dockerSteps(source);
  if (path.includes("/.github/workflows/")) return githubWorkflowJobs(source);
  if ([".sh", ".bash"].includes(extname(path).toLowerCase())) return shellFunctions(source);
  return [];
}

function extractImports(path: string, source: string): ImportHit[] {
  const name = basename(path).toLowerCase();
  if (name === "dockerfile" || name.endsWith(".dockerfile")) {
    return [...source.matchAll(/^\s*FROM\s+([^\s]+)(?:\s+AS\s+([^\s]+))?/gim)].map((match) => ({
      id: normalizeId(match[1] ?? "image"),
      title: match[1] ?? "image",
      kind: match[2] ? `docker image alias ${match[2]}` : "docker image",
    }));
  }
  if (path.includes("/.github/workflows/")) {
    return [...source.matchAll(/\buses:\s*([^\s#]+)/gi)].map((match) => ({
      id: normalizeId(match[1] ?? "action"),
      title: match[1] ?? "action",
      kind: "github action",
    }));
  }
  return [];
}

function packageScripts(source: string): WorkflowHit[] {
  try {
    const parsed = JSON.parse(source) as { scripts?: Record<string, unknown> };
    return Object.entries(parsed.scripts ?? {}).map(([name, command]) => ({
      id: normalizeId(name),
      title: `npm script ${name}`,
      kind: "package-script",
      line: lineForText(source, `"${name}"`),
      summary: typeof command === "string" ? command : "package script",
    }));
  } catch {
    return [];
  }
}

function dockerSteps(source: string): WorkflowHit[] {
  return [...source.matchAll(/^\s*(RUN|CMD|ENTRYPOINT|COPY|ADD)\s+(.+)$/gim)].map((match, index) => ({
    id: `${String(match[1] ?? "step").toLowerCase()}-${index + 1}`,
    title: `${String(match[1] ?? "STEP").toUpperCase()} ${String(match[2] ?? "").slice(0, 80)}`.trim(),
    kind: "docker-step",
    line: lineForIndex(source, match.index ?? 0),
    summary: String(match[2] ?? "").trim(),
  }));
}

function githubWorkflowJobs(source: string): WorkflowHit[] {
  const jobsBlock = source.match(/^jobs:\s*\n([\s\S]*)/m)?.[1] ?? "";
  const hits: WorkflowHit[] = [];
  for (const match of jobsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)) {
    const name = match[1] ?? "job";
    hits.push({
      id: normalizeId(name),
      title: `GitHub Actions job ${name}`,
      kind: "github-actions-job",
      line: lineForIndex(source, source.indexOf(match[0])),
    });
  }
  return hits;
}

function shellFunctions(source: string): WorkflowHit[] {
  const hits: WorkflowHit[] = [];
  const patterns = [
    /^\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/gm,
    /^\s*function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?\s*\{/gm,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const name = match[1] ?? "function";
      hits.push({
        id: normalizeId(name),
        title: `shell function ${name}`,
        kind: "shell-function",
        line: lineForIndex(source, match.index ?? 0),
      });
    }
  }
  return hits;
}

function lineForText(source: string, needle: string): number {
  const index = source.indexOf(needle);
  return lineForIndex(source, index < 0 ? 0 : index);
}

function lineForIndex(source: string, index: number): number {
  return (source.slice(0, index).match(/\n/g)?.length ?? 0) + 1;
}

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-|-$/g, "") || "item";
}
