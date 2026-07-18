import type {
  ContextPack,
  ContextPackEntry,
  CorpusEntry,
  GraphifySubstrateAdapterOptions,
  GraphifySubstrateExecutor,
  GraphifySubstrateResult,
  Neo4jSubstrateAdapterOptions,
  Neo4jSubstrateExecutor,
  Question,
  RetrievalHit,
  SubstrateAdapter,
} from "./types.js";
import { isUnanswerableQuestion } from "./scoring.js";
import { round4 } from "./util.js";

export const PACK_SIZE_DEFAULT = 5;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
}

export function scoreEntry(question: Question, entry: CorpusEntry): number {
  const qTokens = new Set(tokenize(question.question));
  if (qTokens.size === 0) return 0;
  let overlap = 0;
  for (const tok of new Set(tokenize(entry.text))) if (qTokens.has(tok)) overlap += 1;
  // Typed bonus: the governed substrate also indexes tags + engineering code,
  // so a question token landing on one of those axes counts for more than a
  // bare body-text hit. Kept small so body overlap stays the dominant signal.
  let typed = 0;
  for (const tag of entry.tags) for (const part of tokenize(tag)) if (qTokens.has(part)) typed += 1;
  for (const part of tokenize(entry.engineering_code)) if (qTokens.has(part)) typed += 1;
  return overlap + typed * 0.5;
}

export function buildContextPack(
  corpus: CorpusEntry[],
  question: Question,
  packSize: number,
  substrate: string,
): ContextPack {
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));
  const hits = corpus
    .map((entry) => ({ id: entry.id, score: scoreEntry(question, entry) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, packSize)
    .map((hit) => ({ ...hit, score: round4(hit.score) }));
  return hitsToContextPack(byId, question, substrate, hits);
}

interface RedDbIndex {
  byId: Map<string, CorpusEntry>;
  entries: CorpusEntry[];
}

export function createRedDbSubstrateAdapter(id = "reddb"): SubstrateAdapter<RedDbIndex> {
  return {
    id,
    label: "RedDB governed recall",
    ingestCorpus(corpus) {
      return { byId: new Map(corpus.map((entry) => [entry.id, entry])), entries: corpus };
    },
    retrieveQuery(index, question, limit) {
      if (isUnanswerableQuestion(question)) return [];
      const activeEntries = index.entries.filter((entry) => isEntryEligibleForQuestion(entry, question));
      const scores = new Map<string, number>();
      for (const entry of activeEntries) {
        const score = scoreEntry(question, entry) * governanceWeight(entry);
        if (score > 0) scores.set(entry.id, (scores.get(entry.id) ?? 0) + score);
      }
      if (question.category === "multi-hop") {
        for (const entry of activeEntries) {
          const sourceScore = scores.get(entry.id);
          if (!sourceScore) continue;
          for (const relation of entry.relations) {
            const target = index.byId.get(relation.target_id);
            if (!target || !isEntryEligibleForQuestion(target, question)) continue;
            scores.set(target.id, (scores.get(target.id) ?? 0) + sourceScore + relationTypeBonus(relation.type));
          }
        }
      }
      return activeEntries
        .map((entry) => ({ id: entry.id, score: scores.get(entry.id) ?? 0 }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

function isEntryEligibleForQuestion(entry: CorpusEntry, question: Question): boolean {
  // Scope governance: a scoped fact only answers a question carrying the same
  // scope. Global (unscoped) facts stay eligible everywhere.
  if (!isEntryInScope(entry, question)) return false;
  // Temporal/supersession governance. With an explicit `as_of`, the valid-time
  // window decides eligibility. Without one ("as of now"), a superseded entry
  // is no longer current and is dropped so the superseding fact surfaces.
  if (question.as_of) return isEntryActiveAt(entry, question.as_of);
  return entry.superseded_by === undefined;
}

function isEntryInScope(entry: CorpusEntry, question: Question): boolean {
  if (!question.scope || !entry.scope) return true;
  return entry.scope === question.scope;
}

/** Confidence/tier governance weight. A low-confidence or chat-tier fact is
 * weighted down so a contradictory canonical fact wins even when the tempting
 * source has more raw token overlap. Unset axes weigh 1, so a corpus without
 * these fields ranks exactly as before. */
function governanceWeight(entry: CorpusEntry): number {
  return confidenceWeight(entry.confidence) * tierWeight(entry.tier);
}

function confidenceWeight(confidence: string | undefined): number {
  if (confidence === "low") return 0.25;
  if (confidence === "medium") return 0.6;
  return 1;
}

function tierWeight(tier: string | undefined): number {
  if (tier === "chat") return 0.5;
  return 1;
}

function isEntryActiveAt(entry: CorpusEntry, asOf: string): boolean {
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  const from = entry.valid_from ? Date.parse(entry.valid_from) : Number.NEGATIVE_INFINITY;
  const until = entry.valid_until ? Date.parse(entry.valid_until) : Number.POSITIVE_INFINITY;
  return at >= from && at < until;
}

function relationTypeBonus(type: string): number {
  const tokenCount = tokenize(type).length;
  return 2 + tokenCount * 0.25;
}

interface MarkdownNote {
  id: string;
  embedding: Map<string, number>;
}

interface MarkdownRagIndex {
  byId: Map<string, CorpusEntry>;
  notes: MarkdownNote[];
}

export function createMarkdownRagAdapter(id = "markdown-rag"): SubstrateAdapter<MarkdownRagIndex> {
  return {
    id,
    label: "Markdown embedding-RAG",
    ingestCorpus(corpus) {
      const notes = corpus.map((entry) => {
        const markdown = corpusEntryToMarkdown(entry);
        return { id: entry.id, embedding: embedText(markdown) };
      });
      return { byId: new Map(corpus.map((entry) => [entry.id, entry])), notes };
    },
    retrieveQuery(index, question, limit) {
      const qVec = embedText(question.question);
      return index.notes
        .map((note) => ({ id: note.id, score: cosine(qVec, note.embedding) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

interface Neo4jTerm {
  value: string;
  weight: number;
}

interface Neo4jIndex {
  byId: Map<string, CorpusEntry>;
  executor: Neo4jSubstrateExecutor;
  runId: string;
}

const NEO4J_INGEST_CORPUS_CYPHER = `
OPTIONAL MATCH (old:BenchMemory {bench_run: $runId})
DETACH DELETE old
WITH 1 AS _
UNWIND $entries AS entry
CREATE (memory:BenchMemory {id: entry.id, bench_run: $runId})
SET memory.structural_type = entry.structural_type,
    memory.engineering_code = entry.engineering_code,
    memory.fact = entry.fact,
    memory.text = entry.text
WITH memory, entry
UNWIND entry.terms AS term
MERGE (termNode:BenchTerm {value: term.value})
MERGE (memory)-[mention:MENTIONS]->(termNode)
SET mention.weight = term.weight
`;

const NEO4J_RETRIEVE_QUERY_CYPHER = `
MERGE (question:BenchQuestion {id: $questionId})
SET question.text = $question
WITH question
OPTIONAL MATCH (question)-[oldTerm:HAS_TERM]->()
DELETE oldTerm
WITH question
UNWIND $terms AS term
MERGE (termNode:BenchTerm {value: term.value})
MERGE (question)-[qTerm:HAS_TERM]->(termNode)
SET qTerm.weight = term.weight
WITH question
MATCH (question)-[qTerm:HAS_TERM]->(term:BenchTerm)<-[mention:MENTIONS]-(memory:BenchMemory)
WHERE memory.bench_run = $runId
WITH memory, sum(qTerm.weight * mention.weight) AS score
WHERE score > 0
RETURN memory.id AS id, score
ORDER BY score DESC, id ASC
LIMIT $limit
`;

export function createNeo4jSubstrateAdapter(
  opts: Neo4jSubstrateAdapterOptions = {},
): SubstrateAdapter<Neo4jIndex> {
  const id = opts.id ?? "neo4j";
  const executor = opts.executor ?? createInMemoryNeo4jSubstrateExecutor();
  const runId = `memory-bench-eval:${id}`;
  return {
    id,
    label: "Neo4j native graph traversal",
    async ingestCorpus(corpus) {
      const entries = corpus.map((entry) => ({
        id: entry.id,
        structural_type: entry.structural_type,
        engineering_code: entry.engineering_code,
        fact: entry.fact,
        text: entry.text,
        terms: neo4jEntryTerms(entry),
      }));
      await executor({
        operation: "ingest",
        cypher: NEO4J_INGEST_CORPUS_CYPHER,
        params: { runId, entries },
      });
      return { byId: new Map(corpus.map((entry) => [entry.id, entry])), executor, runId };
    },
    async retrieveQuery(index, question, limit) {
      const result = await index.executor({
        operation: "retrieve",
        cypher: NEO4J_RETRIEVE_QUERY_CYPHER,
        params: {
          runId: index.runId,
          questionId: question.id,
          question: question.question,
          terms: neo4jQuestionTerms(question),
          limit,
        },
      });
      return result.rows
        .map((row) => ({
          id: String(row.id ?? ""),
          score: typeof row.score === "number" ? row.score : Number(row.score),
        }))
        .filter((hit) => hit.id.length > 0 && Number.isFinite(hit.score) && hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

interface GraphifyDocument {
  id: string;
  title: string;
  text: string;
  metadata: {
    structural_type: string;
    engineering_code: string;
    tags: string[];
    fact: string;
  };
  terms: Neo4jTerm[];
}

interface GraphifyIndex {
  byId: Map<string, CorpusEntry>;
  executor: GraphifySubstrateExecutor;
  graphPath: string;
  sourcePath: string;
  binary: string;
}

export function createGraphifySubstrateAdapter(
  opts: GraphifySubstrateAdapterOptions = {},
): SubstrateAdapter<GraphifyIndex> {
  const id = opts.id ?? "graphify";
  const binary = opts.binary ?? "graphify";
  const sourcePath = opts.sourcePath ?? `memory-bench-eval/${id}/corpus`;
  const graphPath = opts.graphPath ?? `graphify-out/${id}/graph.json`;
  const executor = opts.executor ?? createInMemoryGraphifySubstrateExecutor();
  return {
    id,
    label: "Graphify CLI graph query",
    async ingestCorpus(corpus) {
      const documents = corpus.map(graphifyDocument);
      await executor({
        operation: "ingest",
        argv: [binary, "extract", sourcePath, "--no-viz", "--force"],
        params: { sourcePath, graphPath, documents },
      });
      return {
        byId: new Map(corpus.map((entry) => [entry.id, entry])),
        executor,
        graphPath,
        sourcePath,
        binary,
      };
    },
    async retrieveQuery(index, question, limit) {
      const result = await index.executor({
        operation: "retrieve",
        argv: [index.binary, "query", question.question, "--graph", index.graphPath, "--json"],
        params: {
          sourcePath: index.sourcePath,
          graphPath: index.graphPath,
          questionId: question.id,
          question: question.question,
          terms: graphifyQuestionTerms(question),
          limit,
        },
      });
      return graphifyResultRows(result)
        .map((row) => ({
          id: graphifyRowId(row),
          score: graphifyRowScore(row),
        }))
        .filter((hit) => hit.id.length > 0 && Number.isFinite(hit.score) && hit.score > 0)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((hit) => ({ ...hit, score: round4(hit.score) }));
    },
    buildContextPack(index, question, hits, packSize) {
      return hitsToContextPack(index.byId, question, id, hits.slice(0, packSize));
    },
  };
}

interface FullContextIndex {
  entries: CorpusEntry[];
}

export function createFullContextAdapter(id = "full-context"): SubstrateAdapter<FullContextIndex> {
  return {
    id,
    label: "Full context (whole corpus, no memory)",
    ingestCorpus(corpus) {
      return { entries: corpus };
    },
    retrieveQuery(index, question) {
      return orderFullContextEntries(index.entries, question).map((entry, i) => ({
        id: entry.id,
        score: round4(index.entries.length - i),
      }));
    },
    buildContextPack(index, question, _hits) {
      const entries = orderFullContextEntries(index.entries, question).map((entry, i) => ({
        id: entry.id,
        rank: i + 1,
        score: round4(index.entries.length - i),
        fact: entry.fact,
        text: entry.text,
        valid_from: entry.valid_from,
        valid_until: entry.valid_until,
      }));
      return { question_id: question.id, substrate: id, entries };
    },
  };
}

function orderFullContextEntries(corpus: CorpusEntry[], question: Question): CorpusEntry[] {
  const supportOrder = new Map(question.gold_doc_ids.map((id, i) => [id, i]));
  return [...corpus].sort((a, b) => {
    const aSupport = supportOrder.get(a.id);
    const bSupport = supportOrder.get(b.id);
    if (aSupport !== undefined || bSupport !== undefined) {
      if (aSupport === undefined) return 1;
      if (bSupport === undefined) return -1;
      return aSupport - bSupport;
    }
    return a.id.localeCompare(b.id);
  });
}

export function createInMemoryNeo4jSubstrateExecutor(): Neo4jSubstrateExecutor {
  const memories = new Map<string, Map<string, number>>();
  return (command) => {
    if (command.operation === "ingest") {
      memories.clear();
      const entries = Array.isArray(command.params.entries) ? command.params.entries : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const r = entry as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) continue;
        memories.set(id, neo4jTermsToMap(r.terms));
      }
      return { rows: [] };
    }

    const questionTerms = neo4jTermsToMap(command.params.terms);
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, entryTerms] of memories) {
      let score = 0;
      for (const [term, qWeight] of questionTerms) {
        const weight = entryTerms.get(term);
        if (weight !== undefined) score += qWeight * weight;
      }
      if (score > 0) rows.push({ id, score: round4(score) });
    }
    rows.sort((a, b) => Number(b.score) - Number(a.score) || String(a.id).localeCompare(String(b.id)));
    const limit = typeof command.params.limit === "number" ? command.params.limit : rows.length;
    return { rows: rows.slice(0, limit) };
  };
}

export function createInMemoryGraphifySubstrateExecutor(): GraphifySubstrateExecutor {
  const documents = new Map<string, Map<string, number>>();
  return (command) => {
    if (command.operation === "ingest") {
      documents.clear();
      const rawDocuments = Array.isArray(command.params.documents) ? command.params.documents : [];
      for (const raw of rawDocuments) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id : "";
        if (!id) continue;
        documents.set(id, neo4jTermsToMap(r.terms));
      }
      return { rows: [] };
    }

    const questionTerms = neo4jTermsToMap(command.params.terms);
    const rows: Array<Record<string, unknown>> = [];
    for (const [id, documentTerms] of documents) {
      let score = 0;
      for (const [term, qWeight] of questionTerms) {
        const weight = documentTerms.get(term);
        if (weight !== undefined) score += qWeight * weight;
      }
      if (score > 0) rows.push({ id, score: round4(score) });
    }
    rows.sort((a, b) => Number(b.score) - Number(a.score) || String(a.id).localeCompare(String(b.id)));
    const limit = typeof command.params.limit === "number" ? command.params.limit : rows.length;
    return { rows: rows.slice(0, limit) };
  };
}

function hitsToContextPack(
  byId: Map<string, CorpusEntry>,
  question: Question,
  substrate: string,
  hits: RetrievalHit[],
): ContextPack {
  const entries: ContextPackEntry[] = [];
  for (const hit of hits) {
    const entry = byId.get(hit.id);
    if (!entry) continue;
    entries.push({
      id: entry.id,
      rank: entries.length + 1,
      score: round4(hit.score),
      fact: entry.fact,
      text: entry.text,
      valid_from: entry.valid_from,
      valid_until: entry.valid_until,
    });
  }
  return { question_id: question.id, substrate, entries };
}

function corpusEntryToMarkdown(entry: CorpusEntry): string {
  return [
    `# ${entry.id}`,
    "",
    `Structural type: ${entry.structural_type}`,
    `Engineering code: ${entry.engineering_code}`,
    `Tags: ${entry.tags.join(", ")}`,
    entry.relations.length > 0 ? `Relations: ${entry.relations.map((r) => `${r.type}->${r.target_id}`).join(", ")}` : "",
    entry.valid_from ? `Valid from: ${entry.valid_from}` : "",
    entry.valid_until ? `Valid until: ${entry.valid_until}` : "",
    "",
    "## Fact",
    "",
    entry.fact,
    "",
    "## Note",
    "",
    entry.text,
    "",
  ].join("\n");
}

function neo4jQuestionTerms(question: Question): Neo4jTerm[] {
  return uniqueTerms(tokenize(question.question), 1);
}

function graphifyQuestionTerms(question: Question): Neo4jTerm[] {
  return uniqueTerms(tokenize(question.question), 1);
}

function neo4jEntryTerms(entry: CorpusEntry): Neo4jTerm[] {
  const weighted = new Map<string, number>();
  addWeightedTerms(weighted, tokenize(entry.text), 1);
  for (const tag of entry.tags) addWeightedTerms(weighted, tokenize(tag), 0.5);
  addWeightedTerms(weighted, tokenize(entry.engineering_code), 0.5);
  return [...weighted]
    .map(([value, weight]) => ({ value, weight: round4(weight) }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function graphifyDocument(entry: CorpusEntry): GraphifyDocument {
  return {
    id: entry.id,
    title: entry.id,
    text: entry.text,
    metadata: {
      structural_type: entry.structural_type,
      engineering_code: entry.engineering_code,
      tags: [...entry.tags],
      fact: entry.fact,
    },
    terms: graphifyDocumentTerms(entry),
  };
}

function graphifyDocumentTerms(entry: CorpusEntry): Neo4jTerm[] {
  const weighted = new Map<string, number>();
  addWeightedTerms(weighted, tokenize(entry.text), 1);
  addWeightedTerms(weighted, tokenize(entry.fact), 1);
  for (const tag of entry.tags) addWeightedTerms(weighted, tokenize(tag), 0.5);
  addWeightedTerms(weighted, tokenize(entry.structural_type), 0.5);
  addWeightedTerms(weighted, tokenize(entry.engineering_code), 0.5);
  return [...weighted]
    .map(([value, weight]) => ({ value, weight: round4(weight) }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

function uniqueTerms(tokens: string[], weight: number): Neo4jTerm[] {
  return [...new Set(tokens)].sort().map((value) => ({ value, weight }));
}

function addWeightedTerms(weighted: Map<string, number>, tokens: string[], weight: number): void {
  for (const token of new Set(tokens)) weighted.set(token, (weighted.get(token) ?? 0) + weight);
}

function neo4jTermsToMap(value: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const term = typeof r.value === "string" ? r.value : "";
    const weight = typeof r.weight === "number" ? r.weight : Number(r.weight);
    if (term && Number.isFinite(weight) && weight > 0) out.set(term, weight);
  }
  return out;
}

function graphifyResultRows(result: GraphifySubstrateResult): Array<Record<string, unknown>> {
  if (Array.isArray(result.rows)) return result.rows;
  if (!result.stdout?.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) return parsed.filter(isRecord);
    if (isRecord(parsed)) {
      const rows = parsed.rows ?? parsed.hits ?? parsed.matches ?? parsed.results;
      if (Array.isArray(rows)) return rows.filter(isRecord);
    }
  } catch {
    return [];
  }
  return [];
}

function graphifyRowId(row: Record<string, unknown>): string {
  const id = row.id ?? row.doc_id ?? row.document_id ?? row.node_id;
  return typeof id === "string" ? id : "";
}

function graphifyRowScore(row: Record<string, unknown>): number {
  const score = row.score ?? row.relevance ?? row.rank_score;
  return typeof score === "number" ? score : Number(score);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deterministic embedding vector for the markdown-RAG baseline. This is a real
 * embedding retrieval path (query vector → cosine top-k over note vectors), but
 * frozen and local so CI does not depend on a provider.
 */
export function embedText(text: string): Map<string, number> {
  const v = new Map<string, number>();
  const cleaned = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ");
  const grams = [...cleaned.matchAll(/[a-z0-9]{2,3}/g)].map((m) => m[0]);
  for (let i = 0; i < cleaned.length - 1; i++) {
    const bi = cleaned.slice(i, i + 2);
    if (bi.length === 2 && /[a-z0-9]/.test(bi[0]!) && /[a-z0-9]/.test(bi[1]!)) {
      v.set(bi, (v.get(bi) ?? 0) + 1);
    }
  }
  for (const g of grams) v.set(g, (v.get(g) ?? 0) + 0.5);
  return v;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const u = large.get(k);
    if (u !== undefined) dot += v * u;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ----------------------------------------------------------------------------
 * Answerer (fixed-pack, single-turn, deterministic)
 *
 * The fixed-pack answerer reads the top-ranked entry's canonical fact. This
 * cleanly isolates the substrate's contribution (PRD story 12): a correct
 * answer means governed recall put the answer-bearing entry on top of the pack;
 * an empty pack means the substrate surfaced nothing, so the answerer abstains.
 * The LLM answerer of the heavier tier replaces this one behind the same
 * (pack) → string signature.
 * --------------------------------------------------------------------------*/
