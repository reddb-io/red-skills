import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import {
  redactSensitiveValue,
  scanPrivacyRecords,
  type PrivacyFinding,
  type SensitiveKind,
} from "./privacy.js";
import type { Confidence } from "./schema.js";

export const EVIDENCE_CARD_CONTRACT = "memory.evidence_card.experimental.v0";

export type EvidenceCardStatus = "pending" | "approved" | "rejected";
export type EvidenceReviewState = "unreviewed" | "approved" | "rejected";
export type EvidenceProposalApplyState = "unlinked" | "pending" | "applied" | "rejected" | "unknown";

export interface EvidenceCitation {
  label: string;
  uri?: string;
  quote?: string;
}

export interface EvidenceCard {
  contract: typeof EVIDENCE_CARD_CONTRACT;
  id: string;
  status: EvidenceCardStatus;
  source: {
    kind: string;
    ref: string;
    collected_at?: string;
  };
  summary: string;
  citations: EvidenceCitation[];
  proposed_lesson: {
    text: string;
    scope?: string;
  };
  route: {
    target: string;
    rationale?: string;
  };
  confidence: Confidence;
  blast_radius: {
    scope: string;
    rationale?: string;
  };
  privacy: {
    redacted: boolean;
    findings: PrivacyFinding[];
    notes: string[];
  };
  judge: {
    score: number;
    rationale: string;
  };
  review: {
    state: EvidenceReviewState;
    reviewer?: string;
    reviewed_at?: string;
    reason?: string;
  };
  proposal_link: {
    kind: string;
    id?: string;
    path?: string;
    apply_state: EvidenceProposalApplyState;
  };
  created_at: string;
  updated_at: string;
}

export interface CreateEvidenceCardInput {
  source: EvidenceCard["source"];
  summary: string;
  citations: EvidenceCitation[];
  proposedLesson: EvidenceCard["proposed_lesson"];
  route: EvidenceCard["route"];
  confidence: Confidence;
  blastRadius: EvidenceCard["blast_radius"];
  privacyNotes?: string[];
  judge: EvidenceCard["judge"];
  proposalLink?: Partial<EvidenceCard["proposal_link"]>;
}

const EvidenceCardStatusZ = z.enum(["pending", "approved", "rejected"]);
const EvidenceReviewStateZ = z.enum(["unreviewed", "approved", "rejected"]);
const EvidenceProposalApplyStateZ = z.enum(["unlinked", "pending", "applied", "rejected", "unknown"]);
const ConfidenceZ = z.enum(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);
const SensitiveKindZ: z.ZodType<SensitiveKind> = z.enum([
  "aws-access-key-id",
  "openai-token",
  "github-token",
  "slack-token",
  "private-key",
  "credential-field",
]);

const PrivacyFindingZ = z.object({
  kind: SensitiveKindZ,
  severity: z.enum(["warning", "error"]),
  memoryId: z.string().min(1),
  location: z.string().min(1),
  message: z.string().min(1),
  excerpt: z.string(),
  redacted: z.string().min(1),
});

export const EvidenceCardZ = z.object({
  contract: z.literal(EVIDENCE_CARD_CONTRACT),
  id: z.string().regex(/^evidence-[a-f0-9]{12}$/),
  status: EvidenceCardStatusZ,
  source: z.object({
    kind: z.string().min(1),
    ref: z.string().min(1),
    collected_at: z.string().datetime().optional(),
  }).strict(),
  summary: z.string().min(1),
  citations: z.array(z.object({
    label: z.string().min(1),
    uri: z.string().min(1).optional(),
    quote: z.string().min(1).optional(),
  }).strict()).min(1),
  proposed_lesson: z.object({
    text: z.string().min(1),
    scope: z.string().min(1).optional(),
  }).strict(),
  route: z.object({
    target: z.string().min(1),
    rationale: z.string().min(1).optional(),
  }).strict(),
  confidence: ConfidenceZ,
  blast_radius: z.object({
    scope: z.string().min(1),
    rationale: z.string().min(1).optional(),
  }).strict(),
  privacy: z.object({
    redacted: z.boolean(),
    findings: z.array(PrivacyFindingZ.strict()),
    notes: z.array(z.string()),
  }).strict(),
  judge: z.object({
    score: z.number().min(0).max(1),
    rationale: z.string().min(1),
  }).strict(),
  review: z.object({
    state: EvidenceReviewStateZ,
    reviewer: z.string().min(1).optional(),
    reviewed_at: z.string().datetime().optional(),
    reason: z.string().min(1).optional(),
  }).strict(),
  proposal_link: z.object({
    kind: z.string().min(1),
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    apply_state: EvidenceProposalApplyStateZ,
  }).strict(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();

export function evidenceInboxRoot(rootDir: string): string {
  return join(rootDir, ".red", "memory", "inbox", "evidence");
}

export async function createEvidenceCard(
  rootDir: string,
  input: CreateEvidenceCardInput,
  now: Date = new Date(),
): Promise<EvidenceCard> {
  const createdAt = now.toISOString();
  const id = `evidence-${hashParts([
    input.source.kind,
    input.source.ref,
    input.summary,
    input.proposedLesson.text,
  ]).slice(0, 12)}`;
  const card: EvidenceCard = {
    contract: EVIDENCE_CARD_CONTRACT,
    id,
    status: "pending",
    source: compactObject({
      kind: input.source.kind,
      ref: input.source.ref,
      collected_at: input.source.collected_at,
    }),
    summary: input.summary,
    citations: input.citations.map((citation) => compactObject(citation)),
    proposed_lesson: compactObject(input.proposedLesson),
    route: compactObject(input.route),
    confidence: input.confidence,
    blast_radius: compactObject(input.blastRadius),
    privacy: {
      redacted: false,
      findings: [],
      notes: input.privacyNotes ?? [],
    },
    judge: input.judge,
    review: {
      state: "unreviewed",
    },
    proposal_link: compactObject({
      kind: input.proposalLink?.kind ?? "none",
      id: input.proposalLink?.id,
      path: input.proposalLink?.path,
      apply_state: input.proposalLink?.apply_state ?? "unlinked",
    }),
    created_at: createdAt,
    updated_at: createdAt,
  };
  const privacyFindings = scanPrivacyRecords([
    {
      id,
      location: `memory evidence ${id}`,
      fields: card as unknown as Record<string, unknown>,
    },
  ]);
  const redactedCard = redactSensitiveValue({
    ...card,
    privacy: {
      ...card.privacy,
      redacted: privacyFindings.length > 0,
      findings: privacyFindings,
    },
  }) as EvidenceCard;
  const validated = validateEvidenceCard(redactedCard);
  await writeEvidenceCard(rootDir, validated);
  return validated;
}

export async function listEvidenceCards(rootDir: string): Promise<EvidenceCard[]> {
  let entries: string[];
  try {
    entries = await readdir(evidenceInboxRoot(rootDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const cards: EvidenceCard[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    cards.push(await readEvidenceCard(rootDir, entry.slice(0, -".yaml".length)));
  }
  return cards.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}

export async function readEvidenceCard(rootDir: string, id: string): Promise<EvidenceCard> {
  const path = evidenceCardPath(rootDir, id);
  try {
    return parseEvidenceCardYaml(await readFile(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`memory evidence card not found: ${id}`);
    }
    throw err;
  }
}

export async function approveEvidenceCard(
  rootDir: string,
  id: string,
  reviewer: string | undefined,
  now: Date = new Date(),
): Promise<EvidenceCard> {
  const card = await readEvidenceCard(rootDir, id);
  if (card.status === "approved") return card;
  if (card.status !== "pending") {
    throw new Error(`memory evidence card ${id} cannot be approved from status ${card.status}`);
  }
  const updated = validateEvidenceCard({
    ...card,
    status: "approved",
    review: compactObject({
      state: "approved",
      reviewer,
      reviewed_at: now.toISOString(),
    }),
    updated_at: now.toISOString(),
  });
  await writeEvidenceCard(rootDir, updated);
  return updated;
}

export async function rejectEvidenceCard(
  rootDir: string,
  id: string,
  reason: string,
  reviewer: string | undefined,
  now: Date = new Date(),
): Promise<EvidenceCard> {
  const rejectionReason = reason.trim();
  if (!rejectionReason) throw new Error("memory evidence reject requires --reason <text>");
  const card = await readEvidenceCard(rootDir, id);
  if (card.status === "rejected") return card;
  if (card.status !== "pending") {
    throw new Error(`memory evidence card ${id} cannot be rejected from status ${card.status}`);
  }
  const redactedReason = redactSensitiveValue(rejectionReason) as string;
  const updated = validateEvidenceCard({
    ...card,
    status: "rejected",
    review: compactObject({
      state: "rejected",
      reviewer,
      reviewed_at: now.toISOString(),
      reason: redactedReason,
    }),
    updated_at: now.toISOString(),
  });
  await writeEvidenceCard(rootDir, updated);
  return updated;
}

export async function writeEvidenceCard(rootDir: string, card: EvidenceCard): Promise<void> {
  const validated = validateEvidenceCard(redactSensitiveValue(card) as EvidenceCard);
  await mkdir(evidenceInboxRoot(rootDir), { recursive: true });
  await writeFile(evidenceCardPath(rootDir, validated.id), formatEvidenceCardYaml(validated), "utf8");
}

export function parseEvidenceCardYaml(raw: string): EvidenceCard {
  const parsed = matter(raw);
  if (Object.keys(parsed.data).length === 0) {
    throw new Error("evidence card YAML is empty or missing a YAML document");
  }
  return validateEvidenceCard(normalizeYamlValue(parsed.data));
}

export function formatEvidenceCardYaml(card: EvidenceCard): string {
  const validated = validateEvidenceCard(redactSensitiveValue(card) as EvidenceCard);
  return `${matter.stringify("", validated, { language: "yaml" }).trimEnd()}\n`;
}

export function validateEvidenceCard(value: unknown): EvidenceCard {
  const result = EvidenceCardZ.safeParse(normalizeYamlValue(value));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid Evidence card: ${details}`);
  }
  return result.data;
}

function evidenceCardPath(rootDir: string, id: string): string {
  if (!/^evidence-[a-f0-9]{12}$/.test(id)) throw new Error(`invalid memory evidence id: ${id}`);
  return join(evidenceInboxRoot(rootDir), `${id}.yaml`);
}

function hashParts(parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) h.update(part).update("\0");
  return h.digest("hex");
}

function compactObject<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function normalizeYamlValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeYamlValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normalizeYamlValue(item),
      ]),
    );
  }
  return value;
}
