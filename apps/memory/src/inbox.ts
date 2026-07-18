import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyCandidateMemory, type StoreClassification } from "./store-classifier.js";
import {
  redactSensitiveText,
  scanPrivacyRecords,
  type PrivacyFinding,
} from "./privacy.js";
import type { Confidence, MemoryProvenance, MemoryScope } from "./schema.js";
import { readMemoryStateFile, writeMemoryStateFile } from "./toon-state.js";

export type InboxStatus = "quarantined" | "approved" | "rejected" | "promoted";

export interface InboxProvenanceContext {
  sourceKind: MemoryProvenance["source_kind"];
  writer?: string;
  command?: string;
  hook?: string;
  confidence: Confidence;
  scope?: {
    level?: MemoryScope;
    id?: string;
  };
}

export interface MemoryInboxItem {
  id: string;
  status: InboxStatus;
  fact: string;
  reason: string;
  evidenceSummary: string;
  classification: StoreClassification;
  privacyFindings: PrivacyFinding[];
  provenance: InboxProvenanceContext;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
  promotedAt?: string;
  promotedRid?: number;
}

export interface QuarantineInboxInput {
  fact: string;
  reason: string;
  evidenceSummary: string;
  provenance?: Partial<InboxProvenanceContext>;
}

export function inboxRoot(rootDir: string): string {
  return join(rootDir, ".red", "memory", "inbox");
}

export async function quarantineInboxItem(
  rootDir: string,
  input: QuarantineInboxInput,
  now: Date = new Date(),
): Promise<MemoryInboxItem> {
  const fact = input.fact.trim();
  const reason = input.reason.trim();
  const evidenceSummary = input.evidenceSummary.trim();
  if (!fact) throw new Error("memory inbox quarantine needs a proposed fact");
  if (!reason) throw new Error("memory inbox quarantine requires --reason <text>");
  if (!evidenceSummary) throw new Error("memory inbox quarantine requires --evidence <summary>");

  const createdAt = now.toISOString();
  const id = `inbox-${hashParts([fact, reason, evidenceSummary, createdAt]).slice(0, 12)}`;
  const fields = {
    fact,
    reason,
    evidenceSummary,
  };
  const privacyFindings = scanPrivacyRecords([
    {
      id,
      location: `memory inbox ${id}`,
      fields,
    },
  ]);
  const provenance = normalizeProvenance(input.provenance);
  const item: MemoryInboxItem = {
    id,
    status: "quarantined",
    fact: redactSensitiveText(fact),
    reason: redactSensitiveText(reason),
    evidenceSummary: redactSensitiveText(evidenceSummary),
    classification: classifyCandidateMemory(fact),
    privacyFindings,
    provenance,
    createdAt,
    updatedAt: createdAt,
  };
  await writeInboxItem(rootDir, item);
  return item;
}

export async function listInboxItems(rootDir: string): Promise<MemoryInboxItem[]> {
  let entries: string[];
  try {
    entries = await readdir(inboxRoot(rootDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const items: MemoryInboxItem[] = [];
  for (const entry of entries) {
    const id = inboxIdFromFile(entry);
    if (!id) continue;
    items.push(await readInboxItem(rootDir, id));
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export async function readInboxItem(rootDir: string, id: string): Promise<MemoryInboxItem> {
  const path = await existingInboxPath(rootDir, id);
  try {
    return await readMemoryStateFile<MemoryInboxItem>(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`memory inbox item not found: ${id}`);
    }
    throw err;
  }
}

export async function approveInboxItem(
  rootDir: string,
  id: string,
  now: Date = new Date(),
): Promise<MemoryInboxItem> {
  const item = await readInboxItem(rootDir, id);
  if (item.status === "approved") return item;
  if (item.status !== "quarantined") {
    throw new Error(`memory inbox item ${id} cannot be approved from status ${item.status}`);
  }
  const updated = {
    ...item,
    status: "approved" as const,
    approvedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await writeInboxItem(rootDir, updated);
  return updated;
}

export async function rejectInboxItem(
  rootDir: string,
  id: string,
  rejectionReason: string,
  now: Date = new Date(),
): Promise<MemoryInboxItem> {
  const item = await readInboxItem(rootDir, id);
  const reason = rejectionReason.trim();
  if (!reason) throw new Error("memory inbox reject requires --reason <text>");
  if (item.status === "promoted") {
    throw new Error(`memory inbox item ${id} cannot be rejected after promotion`);
  }
  if (item.status === "rejected") return item;
  const updated = {
    ...item,
    status: "rejected" as const,
    rejectionReason: redactSensitiveText(reason),
    rejectedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await writeInboxItem(rootDir, updated);
  return updated;
}

export async function markInboxItemPromoted(
  rootDir: string,
  id: string,
  promotedRid: number,
  now: Date = new Date(),
): Promise<MemoryInboxItem> {
  const item = await readInboxItem(rootDir, id);
  if (item.status !== "approved") {
    throw new Error(`memory inbox item ${id} must be approved before promotion`);
  }
  const updated = {
    ...item,
    status: "promoted" as const,
    promotedRid,
    promotedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await writeInboxItem(rootDir, updated);
  return updated;
}

export function inboxItemToProvenance(item: MemoryInboxItem): MemoryProvenance {
  return {
    source_kind: item.provenance.sourceKind,
    ...(item.provenance.writer ? { writer: item.provenance.writer } : {}),
    ...(item.provenance.command ? { command: item.provenance.command } : {}),
    ...(item.provenance.hook ? { hook: item.provenance.hook } : {}),
    confidence: item.provenance.confidence,
    evidence: [item.evidenceSummary],
    ...(item.provenance.scope ? { scope: item.provenance.scope } : {}),
  };
}

async function writeInboxItem(rootDir: string, item: MemoryInboxItem): Promise<void> {
  await mkdir(inboxRoot(rootDir), { recursive: true });
  await writeMemoryStateFile(inboxPath(rootDir, item.id), item);
}

function inboxPath(rootDir: string, id: string): string {
  if (!/^inbox-[a-f0-9]{12}$/.test(id)) throw new Error(`invalid memory inbox id: ${id}`);
  return join(inboxRoot(rootDir), `${id}.toon`);
}

async function existingInboxPath(rootDir: string, id: string): Promise<string> {
  const toonPath = inboxPath(rootDir, id);
  try {
    await readFile(toonPath);
    return toonPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!/^inbox-[a-f0-9]{12}$/.test(id)) throw new Error(`invalid memory inbox id: ${id}`);
  return join(inboxRoot(rootDir), `${id}.json`);
}

function inboxIdFromFile(file: string): string | null {
  const match = /^(inbox-[a-f0-9]{12})\.(?:toon|json)$/.exec(file);
  return match?.[1] ?? null;
}

function normalizeProvenance(input: Partial<InboxProvenanceContext> = {}): InboxProvenanceContext {
  const sourceKind = input.sourceKind ?? "manual";
  const confidence = input.confidence ?? "INFERRED";
  return {
    sourceKind,
    ...(input.writer ? { writer: input.writer } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.hook ? { hook: input.hook } : {}),
    confidence,
    ...(input.scope ? { scope: input.scope } : {}),
  };
}

function hashParts(parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) h.update(part).update("\0");
  return h.digest("hex");
}
