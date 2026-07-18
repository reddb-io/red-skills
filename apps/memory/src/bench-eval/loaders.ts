import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CorpusEntry, CorpusRelation, Question } from "./types.js";

/* ----------------------------------------------------------------------------
 * Corpus + question loaders
 * --------------------------------------------------------------------------*/

export async function loadCorpus(dir: string): Promise<CorpusEntry[]> {
  const raw = await readFile(join(dir, "corpus.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("corpus.json must be a JSON array");
  return parsed.map(asCorpusEntry);
}

export async function loadQuestions(dir: string): Promise<Question[]> {
  const raw = await readFile(join(dir, "questions.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("questions.json must be a JSON array");
  return parsed.map(asQuestion);
}

function asCorpusEntry(value: unknown): CorpusEntry {
  if (!value || typeof value !== "object") throw new Error("corpus entry must be an object");
  const r = value as Record<string, unknown>;
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === "string") : [];
  const relations = Array.isArray(r.relations) ? r.relations.map(asCorpusRelation) : [];
  return {
    id: stringField(r, "id"),
    structural_type: stringField(r, "structural_type"),
    engineering_code: stringField(r, "engineering_code"),
    tags,
    text: stringField(r, "text"),
    fact: stringField(r, "fact"),
    relations,
    valid_from: optionalStringField(r, "valid_from"),
    valid_until: optionalNullableStringField(r, "valid_until"),
    supersedes: optionalStringField(r, "supersedes"),
    superseded_by: optionalStringField(r, "superseded_by"),
    scope: optionalStringField(r, "scope"),
    confidence: optionalStringField(r, "confidence"),
    tier: optionalStringField(r, "tier"),
  };
}

function asCorpusRelation(value: unknown): CorpusRelation {
  if (!value || typeof value !== "object") throw new Error("corpus relation must be an object");
  const r = value as Record<string, unknown>;
  return {
    type: stringField(r, "type"),
    target_id: stringField(r, "target_id"),
  };
}

function asQuestion(value: unknown): Question {
  if (!value || typeof value !== "object") throw new Error("question entry must be an object");
  const r = value as Record<string, unknown>;
  const goldDocId = stringField(r, "gold_doc_id");
  const goldDocIds = Array.isArray(r.gold_doc_ids)
    ? r.gold_doc_ids.filter((id): id is string => typeof id === "string")
    : [goldDocId];
  return {
    id: stringField(r, "id"),
    category: stringField(r, "category"),
    question: stringField(r, "question"),
    gold_doc_id: goldDocId,
    gold_doc_ids: Array.isArray(r.gold_doc_ids) ? goldDocIds : [goldDocId],
    gold_answer: stringField(r, "gold_answer"),
    as_of: optionalStringField(r, "as_of"),
    scope: optionalStringField(r, "scope"),
  };
}

function stringField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string`);
  return v;
}

function optionalStringField(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string`);
  return v;
}

function optionalNullableStringField(r: Record<string, unknown>, key: string): string | null | undefined {
  const v = r[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new Error(`field "${key}" must be a string or null`);
  return v;
}
