import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { contentHash } from "../hash.js";
import type { MemoryStore, StoredNode } from "../graph-store.js";
import type { MemoryNode, NodeType } from "../schema.js";

export type WorkerLearningKind =
  | "durable_fact"
  | "failure"
  | "validation"
  | "skill_improvement";

export interface WorkerLearningEvidence {
  rid: number;
  label: string;
  nodeType: NodeType;
  description: string;
}

export interface WorkerLearningProposal {
  id: string;
  kind: WorkerLearningKind;
  title: string;
  recommendation: string;
  targetNodeType: NodeType;
  confidence: "EXTRACTED" | "INFERRED";
  evidence: WorkerLearningEvidence[];
  evidenceSummary: string;
}

export interface RejectedWorkerLearning {
  kind: "temporary_progress" | "raw_operational_log";
  action: "rejected" | "downgraded";
  reason: string;
  evidence: WorkerLearningEvidence[];
}

export interface WorkerLearningReport {
  proposals: WorkerLearningProposal[];
  rejected: RejectedWorkerLearning[];
}

export interface WorkerLearningApplyResult {
  applied: number;
  nodeRids: number[];
  edgeRids: number[];
}

export async function buildWorkerLearningReport(
  store: MemoryStore,
): Promise<WorkerLearningReport> {
  const nodes = await store.listNodes();
  const edges = await store.listEdges();
  const workerNodes = nodes
    .filter((node) => node.node_type === "worker")
    .sort(compareWorkerNodes);
  const validations = nodes
    .filter((node) => node.node_type === "validation")
    .sort((a, b) => a.rid - b.rid);

  const proposals: WorkerLearningProposal[] = [];
  const rejected: RejectedWorkerLearning[] = [];

  for (const workerNode of workerNodes) {
    const evidence = [workerEvidence(workerNode)];
    const summary = stringProp(workerNode, "summary") ?? stringProp(workerNode, "content") ?? "";
    const notes = stringProp(workerNode, "notes") ?? "";

    const rejection = rejectionForWorkerText(notes || summary, evidence);
    if (rejection) rejected.push(rejection);

    if (isTerminalFailure(workerNode)) {
      proposals.push(
        proposal({
          kind: "failure",
          title: `Failure: ${String(workerNode.properties.status ?? "worker failed")} on ${workerNode.label}`,
          recommendation: compactText(
            summary ||
              `${workerNode.label} ended with status ${String(workerNode.properties.status ?? "unknown")}.`,
          ),
          targetNodeType: "problem",
          confidence: "EXTRACTED",
          evidence,
        }),
      );

      const skillPath = skillPathFromWorker(workerNode);
      if (skillPath) {
        proposals.push(
          proposal({
            kind: "skill_improvement",
            title: `Skill improvement candidate: ${skillPath}`,
            recommendation: compactText(
              `Review ${skillPath} for missing prerequisites, validation guidance, or recovery steps related to ${String(
                workerNode.properties.error_class ?? workerNode.properties.status ?? "the failed worker",
              )}.`,
            ),
            targetNodeType: "workflow",
            confidence: "INFERRED",
            evidence,
          }),
        );
      }
    }

    if (isDurableFactCandidate(summary)) {
      proposals.push(
        proposal({
          kind: "durable_fact",
          title: `Durable fact from ${workerNode.label}`,
          recommendation: compactText(summary),
          targetNodeType: "decision",
          confidence: "INFERRED",
          evidence,
        }),
      );
    }
  }

  for (const validation of validations) {
    const evidence = [validationEvidence(validation)];
    const failed = isFailedValidation(validation);
    const validationSummary = String(validation.properties.summary ?? "");
    const validationRejection = rejectionForWorkerText(validationSummary, evidence);
    if (validationRejection) rejected.push(validationRejection);
    proposals.push(
      proposal({
        kind: "validation",
        title: `Validation ${String(validation.properties.name ?? validation.label)} ${String(
          validation.properties.status ?? "recorded",
        )}`,
        recommendation: compactText(
          [
            validation.properties.command
              ? `Command \`${String(validation.properties.command)}\``
              : `Validation ${String(validation.properties.name ?? validation.label)}`,
            `finished with status ${String(validation.properties.status ?? "unknown")}.`,
            validationRejection ? "" : validationSummary,
          ].join(" "),
        ),
        targetNodeType: "validation",
        confidence: "EXTRACTED",
        evidence,
      }),
    );
    if (isPassedValidation(validation)) {
      proposals.push(
        proposal({
          kind: "durable_fact",
          title: `Durable fact from validation ${String(validation.properties.name ?? validation.label)}`,
          recommendation: compactText(
            `Validation ${String(validation.properties.name ?? validation.label)} passed for issue ${String(
              validation.properties.issue_number ?? "unknown",
            )}.`,
          ),
          targetNodeType: "decision",
          confidence: "EXTRACTED",
          evidence,
        }),
      );
    }
    if (failed) {
      proposals.push(
        proposal({
          kind: "failure",
          title: `Failure: validation ${String(validation.properties.name ?? validation.label)} failed`,
          recommendation: compactText(
            String(validation.properties.summary ?? "") ||
              `Validation ${String(validation.properties.name ?? validation.label)} failed.`,
          ),
          targetNodeType: "problem",
          confidence: "EXTRACTED",
          evidence,
        }),
      );

      const skillPath = skillPathFromValidation(validation, nodes, edges);
      if (skillPath) {
        proposals.push(
          proposal({
            kind: "skill_improvement",
            title: `Skill improvement candidate: ${skillPath}`,
            recommendation: compactText(
              `Review ${skillPath} for validation guidance related to failed check ${String(
                validation.properties.name ?? validation.label,
              )}.`,
            ),
            targetNodeType: "workflow",
            confidence: "INFERRED",
            evidence,
          }),
        );
      }
    }
  }

  return {
    proposals: dedupeProposals(proposals).sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title),
    ),
    rejected,
  };
}

export async function writeWorkerLearningProposalFile(
  rootDir: string,
  report: WorkerLearningReport,
): Promise<string | null> {
  if (report.proposals.length === 0) return null;
  const fingerprint = reportFingerprint(report);
  const proposalDir = join(rootDir, ".red", "memory", "proposals");
  await mkdir(proposalDir, { recursive: true });
  const file = `worker-learning-${fingerprint.slice(0, 12)}.md`;
  const path = join(proposalDir, file);
  await writeFile(path, renderWorkerLearningProposal(report, fingerprint), "utf8");
  return toPosix(relative(rootDir, path));
}

export function parseWorkerLearningProposal(body: string): WorkerLearningReport {
  const match = body.match(/```json memory-learning-proposal\s*([\s\S]*?)```/);
  if (!match) throw new Error("proposal needs a structured memory-learning-proposal block");
  const raw = JSON.parse(match[1]) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("memory-learning-proposal must be a JSON object");
  }
  const obj = raw as Partial<WorkerLearningReport>;
  if (!Array.isArray(obj.proposals)) {
    throw new Error("memory-learning-proposal.proposals is required");
  }
  return {
    proposals: obj.proposals as WorkerLearningProposal[],
    rejected: Array.isArray(obj.rejected) ? (obj.rejected as RejectedWorkerLearning[]) : [],
  };
}

export async function applyWorkerLearningProposal(
  store: MemoryStore,
  report: WorkerLearningReport,
): Promise<WorkerLearningApplyResult> {
  const nodeRids: number[] = [];
  const edgeRids: number[] = [];

  for (const item of report.proposals) {
    const node: MemoryNode = {
      label: `learning:${item.kind}:${item.id.slice(0, 16)}`,
      node_type: item.targetNodeType,
      properties: {
        title: item.title,
        content: item.recommendation,
        summary: item.evidenceSummary,
        source: "worker-learning",
        confidence: item.confidence,
        tags: ["worker-learning", item.kind],
        hash: contentHash("worker-learning", item.id),
        provenance: {
          source_kind: "derived",
          writer: "memory worker learn apply",
          command: "memory worker learn apply",
          confidence: item.confidence,
          evidence: item.evidence.map((e) => e.description),
        },
      },
    };
    const nodeRid = await store.upsertNode(node);
    nodeRids.push(nodeRid);
    for (const evidence of item.evidence) {
      edgeRids.push(
        await store.upsertEdge({
          label: "LEARNED_FROM",
          from_rid: nodeRid,
          to_rid: evidence.rid,
          properties: { reason: item.kind, source: "worker-learning" },
        }),
      );
    }
  }

  return { applied: report.proposals.length, nodeRids, edgeRids };
}

function proposal(
  input: Omit<WorkerLearningProposal, "id" | "evidenceSummary">,
): WorkerLearningProposal {
  const evidenceSummary = input.evidence.map((e) => e.description).join("; ");
  const id = contentHash(
    "worker-learning",
    input.kind,
    input.title,
    input.recommendation,
    evidenceSummary,
  );
  return { ...input, id, evidenceSummary };
}

function dedupeProposals(items: WorkerLearningProposal[]): WorkerLearningProposal[] {
  const seen = new Set<string>();
  const out: WorkerLearningProposal[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function compareWorkerNodes(a: StoredNode, b: StoredNode): number {
  const repo = String(a.properties.repository ?? "").localeCompare(
    String(b.properties.repository ?? ""),
  );
  if (repo !== 0) return repo;
  const issue = Number(a.properties.issue_number ?? 0) - Number(b.properties.issue_number ?? 0);
  if (issue !== 0) return issue;
  const attempt =
    Number(a.properties.attempt_number ?? 0) - Number(b.properties.attempt_number ?? 0);
  if (attempt !== 0) return attempt;
  return a.rid - b.rid;
}

function workerEvidence(attempt: StoredNode): WorkerLearningEvidence {
  const status = String(attempt.properties.status ?? "unknown");
  const summary = compactText(
    String(attempt.properties.summary ?? attempt.properties.content ?? attempt.properties.title ?? ""),
  );
  return {
    rid: attempt.rid,
    label: attempt.label,
    nodeType: "worker",
    description: `worker rid=${attempt.rid} label=${attempt.label} status=${status}${summary ? ` summary=${summary}` : ""}`,
  };
}

function validationEvidence(validation: StoredNode): WorkerLearningEvidence {
  return {
    rid: validation.rid,
    label: validation.label,
    nodeType: "validation",
    description: `validation rid=${validation.rid} label=${validation.label} name=${String(
      validation.properties.name ?? "",
    )} status=${String(validation.properties.status ?? "unknown")}`,
  };
}

function rejectionForWorkerText(
  text: string,
  evidence: WorkerLearningEvidence[],
): RejectedWorkerLearning | null {
  if (!text) return null;
  if (/\b(raw stdout|raw stderr|operational log|tail of .*log|bg-task|\/tmp\/)\b/i.test(text)) {
    return {
      kind: "raw_operational_log",
      action: "rejected",
      reason: "raw operational logs are not durable Memory facts",
      evidence,
    };
  }
  if (/\b(wip|in progress|still running|trying|next step|todo|temporary)\b/i.test(text)) {
    return {
      kind: "temporary_progress",
      action: "downgraded",
      reason: "temporary progress is worker evidence, not a durable learning",
      evidence,
    };
  }
  return null;
}

function isTerminalFailure(attempt: StoredNode): boolean {
  const status = String(attempt.properties.status ?? "").toLowerCase();
  return status !== "" && status !== "done";
}

function isDurableFactCandidate(text: string): boolean {
  if (!text || text.length < 24) return false;
  if (/\b(wip|still running|trying|todo|raw stdout|raw stderr|operational log)\b/i.test(text)) {
    return false;
  }
  return /\b(must|uses?|stores?|records?|creates?|links?|dedupes?|verifies?|rejects?|requires?|without|approval-gated)\b/i.test(
    text,
  );
}

function skillPathFromWorker(attempt: StoredNode): string | null {
  const touched = attempt.properties.touched_files;
  if (!Array.isArray(touched)) return null;
  for (const item of touched) {
    if (typeof item !== "string") continue;
    if (/((^|\/)skills\/.*\/SKILL\.md$)|(^|\/)SKILL\.md$/i.test(item)) return item;
  }
  return null;
}

function skillPathFromValidation(
  validation: StoredNode,
  nodes: StoredNode[],
  edges: Record<string, unknown>[],
): string | null {
  const testedBy = edges.find(
    (edge) => edgeLabel(edge) === "TESTED_BY" && edgeTo(edge) === validation.rid,
  );
  const attemptRid = edgeFrom(testedBy);
  if (!Number.isFinite(attemptRid)) return null;
  const touched = edges.find(
    (edge) => edgeLabel(edge) === "TOUCHED" && edgeFrom(edge) === attemptRid,
  );
  const fileRid = edgeTo(touched);
  if (!Number.isFinite(fileRid)) return null;
  const file = nodes.find((node) => node.rid === fileRid);
  const path = stringPropFromNode(file, "title") ?? stringPropFromNode(file, "source") ?? "";
  return /(^|\/)skills\/.*\/SKILL\.md$/i.test(path) ? path : null;
}

function edgeLabel(edge: Record<string, unknown> | undefined): string {
  return String(edge?.label ?? edge?.LABEL ?? "");
}

function edgeFrom(edge: Record<string, unknown> | undefined): number {
  return Number(edge?.from ?? edge?.from_rid ?? edge?.FROM ?? edge?.FROM_RID);
}

function edgeTo(edge: Record<string, unknown> | undefined): number {
  return Number(edge?.to ?? edge?.to_rid ?? edge?.TO ?? edge?.TO_RID);
}

function isFailedValidation(validation: StoredNode): boolean {
  const status = String(validation.properties.status ?? "").toLowerCase();
  return status === "failed" || status === "error" || status === "timed-out";
}

function isPassedValidation(validation: StoredNode): boolean {
  const status = String(validation.properties.status ?? "").toLowerCase();
  return status === "passed" || status === "succeeded" || status === "success";
}

function stringProp(node: StoredNode, key: string): string | null {
  const value = node.properties[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringPropFromNode(node: StoredNode | undefined, key: string): string | null {
  if (!node) return null;
  return stringProp(node, key);
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function reportFingerprint(report: WorkerLearningReport): string {
  return contentHash("worker-learning-report", ...report.proposals.map((p) => p.id));
}

function renderWorkerLearningProposal(
  report: WorkerLearningReport,
  fingerprint: string,
): string {
  const kinds = [...new Set(report.proposals.map((p) => p.kind))].join(", ");
  return `# Worker Learning Proposal

Status: approval-gated
Generated: ${new Date().toISOString()}
Fingerprint: ${fingerprint}
Kinds: ${kinds}

## Evidence

${report.proposals.map((p) => `- ${p.kind}: ${p.evidenceSummary}`).join("\n")}

## Proposed Learnings

${report.proposals.map((p) => `- [${p.kind}] ${p.title}: ${p.recommendation}`).join("\n")}

## Rejected Or Downgraded

${report.rejected.length === 0 ? "- none" : report.rejected.map((r) => `- [${r.action}] ${r.kind}: ${r.reason}`).join("\n")}

## Apply Policy

This proposal is approval-gated. Generating it wrote this file only; it did not create durable Memory nodes. Apply only after review with \`memory worker learn apply <proposal> --yes\`.

\`\`\`json memory-learning-proposal
${JSON.stringify(report, null, 2)}
\`\`\`
`;
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}
