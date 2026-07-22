import { posix } from "node:path";
import { encode, type JsonValue } from "@reddb-io/toon";

const CONTEXT_MAP_PATH = ".red/CONTEXT-MAP.md";
const DEFAULT_MAX_BYTES = 2_400;
const MAX_TERMS = 4;
const MAX_EXEMPLARS = 2;
const MAX_PATHS = 8;

export interface HandoffEnrichmentInput {
  title: string;
  body: string;
  labels: readonly string[];
  specRef?: string;
}

export interface HandoffEnrichmentDeps {
  readText(path: string): Promise<string>;
  gitLog(paths: readonly string[]): Promise<string>;
}

export interface HandoffEnrichmentOptions {
  maxBytes?: number;
}

interface ContextEntry {
  name: string;
  path: string;
  description: string;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  avoid?: string;
  score: number;
}

interface Exemplar {
  pr: number;
  title: string;
  shows: string;
}

function oneLine(value: string, max = 320): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function words(value: string): string[] {
  return value
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3);
}

function lexicalWords(value: string): string[] {
  return words(value).map((word) => (word.length >= 5 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
}

function includesWord(haystack: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(
    haystack,
  );
}

function parseContextMap(markdown: string): ContextEntry[] {
  const entries: ContextEntry[] = [];
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- \[([^\]]+)]\(([^)]+\/CONTEXT\.md)\)\s*-\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const description = [match[3] ?? ""];
    while (/^\s{2,}\S/.test(lines[index + 1] ?? "")) {
      index += 1;
      description.push((lines[index] ?? "").trim());
    }
    const linked = match[2] ?? "";
    const path = linked.startsWith("./")
      ? posix.normalize(posix.join(posix.dirname(CONTEXT_MAP_PATH), linked))
      : posix.normalize(linked);
    entries.push({ name: match[1] ?? "", path, description: oneLine(description.join(" ")) });
  }
  return entries;
}

function extractPaths(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|[\s(`'"=])((?:\.?\.?\/)?[A-Za-z0-9_.@{}*-]+(?:\/[A-Za-z0-9_.@{}*-]+)+)/gm;
  for (const match of text.matchAll(pattern)) {
    const candidate = (match[1] ?? "")
      .replace(/[),.;:'"`]+$/g, "")
      .replace(/^\.\//, "");
    if (candidate.length === 0 || candidate.startsWith("http://") || candidate.startsWith("https://")) continue;
    if (candidate.includes("..")) continue;
    if (!found.includes(candidate)) found.push(candidate);
    if (found.length === MAX_PATHS) break;
  }
  return found;
}

function contextScore(entry: ContextEntry, issueText: string, paths: readonly string[]): number {
  const slug = posix.basename(posix.dirname(entry.path)).toLocaleLowerCase("en-US");
  let score = 0;
  if (includesWord(issueText, entry.name.toLocaleLowerCase("en-US"))) score += 20;
  if (includesWord(issueText, slug)) score += 20;
  for (const path of paths) {
    const lower = path.toLocaleLowerCase("en-US");
    if (lower.includes(`/contexts/${slug}/`) || lower.startsWith(`apps/${slug}/`) || lower.startsWith(`plugins/${slug}/`)) {
      score += 30;
    }
  }
  const issueWords = new Set(lexicalWords(issueText));
  const descriptionHits = [...new Set(lexicalWords(entry.description).filter((word) => word.length >= 5))]
    .filter((word) => issueWords.has(word)).length;
  return score + Math.min(descriptionHits, 8);
}

function resolveContext(entries: readonly ContextEntry[], input: HandoffEnrichmentInput, paths: readonly string[]): ContextEntry | undefined {
  const issueText = [input.title, input.body, input.labels.join(" "), input.specRef ? `spec:${input.specRef}` : ""]
    .join("\n")
    .toLocaleLowerCase("en-US");
  return entries
    .map((entry, index) => ({ entry, index, score: contextScore(entry, issueText, paths) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.entry;
}

function parseGlossary(markdown: string, issueText: string): GlossaryTerm[] {
  const lines = markdown.split("\n");
  const terms: GlossaryTerm[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\*\*([^*]+)\*\*:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) continue;
    const body: string[] = [];
    if ((match[2] ?? "").trim()) body.push((match[2] ?? "").trim());
    while (index + 1 < lines.length && !/^\*\*[^*]+\*\*:/.test(lines[index + 1] ?? "") && !/^##\s/.test(lines[index + 1] ?? "")) {
      index += 1;
      const line = (lines[index] ?? "").trim();
      if (line) body.push(line);
    }
    const term = oneLine(match[1] ?? "", 100);
    const avoidLine = body.find((line) => /^_Avoid_:\s*/i.test(line));
    const definition = oneLine(body.filter((line) => !/^_Avoid_:\s*/i.test(line)).join(" "));
    const termWords = words(term);
    const exact = term.length >= 3 && issueText.includes(term.toLocaleLowerCase("en-US")) ? 20 : 0;
    const termHits = termWords.filter((word) => includesWord(issueText, word)).length * 6;
    const definitionHits = [...new Set(words(definition).filter((word) => word.length >= 5))]
      .filter((word) => includesWord(issueText, word)).length;
    const score = exact + termHits + Math.min(definitionHits, 4);
    if (score < 6 || definition.length === 0) continue;
    terms.push({
      term,
      definition,
      ...(avoidLine ? { avoid: oneLine(avoidLine.replace(/^_Avoid_:\s*/i, ""), 160) } : {}),
      score,
    });
  }
  return terms.sort((left, right) => right.score - left.score || left.term.localeCompare(right.term)).slice(0, MAX_TERMS);
}

function exemplarTitle(subject: string, bodyLines: readonly string[]): { pr: number; title: string } | undefined {
  const squash = /^(.*?)\s+\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return { pr: Number(squash[2]), title: oneLine(squash[1] ?? subject, 180) };
  const merge = /^Merge pull request #(\d+)\b/i.exec(subject);
  if (!merge) return undefined;
  const bodyTitle = bodyLines.find((line) => !/^refs?\s+#\d+/i.test(line));
  return { pr: Number(merge[1]), title: oneLine(bodyTitle ?? subject, 180) };
}

function parseExemplars(log: string, paths: readonly string[]): Exemplar[] {
  const exemplars: Exemplar[] = [];
  const seen = new Set<number>();
  for (const record of log.split("\u001e")) {
    const [, rawSubject = "", rawBody = ""] = record.replace(/^\s+|\s+$/g, "").split("\u001f");
    const subject = oneLine(rawSubject, 200);
    const bodyLines = rawBody.split("\n").map((line) => oneLine(line)).filter(Boolean);
    const identified = exemplarTitle(subject, bodyLines);
    if (!identified || seen.has(identified.pr)) continue;
    seen.add(identified.pr);
    const shows = bodyLines.find((line) => line !== identified.title && !/^refs?\s+#\d+/i.test(line))
      ?? `Shows the current approach in ${paths.slice(0, 2).join(" and ")}.`;
    exemplars.push({ ...identified, shows: oneLine(shows, 220) });
    if (exemplars.length === MAX_EXEMPLARS) break;
  }
  return exemplars;
}

function renderBounded(
  context: ContextEntry,
  terms: GlossaryTerm[],
  exemplars: Exemplar[],
  maxBytes: number,
): string {
  const selectedTerms = terms.map(({ score: _score, ...term }) => term);
  const selectedExemplars = exemplars.map(({ pr, title, shows }) => ({ pr, title, shows }));
  for (;;) {
    const payload = {
      context: { name: context.name, glossary_path: context.path },
      glossary_terms: selectedTerms,
      exemplars: selectedExemplars,
    } satisfies JsonValue;
    const rendered = encode(payload);
    if (Buffer.byteLength(rendered, "utf8") <= maxBytes) return rendered;
    if (selectedExemplars.length > 0) selectedExemplars.pop();
    else if (selectedTerms.length > 0) selectedTerms.pop();
    else return "";
  }
}

/**
 * Build the repository-doctrine supplement for an AFK handoff. Every external
 * read is best-effort: enrichment can improve a worker prompt, but can never
 * become a dispatch precondition.
 */
export async function buildHandoffEnrichment(
  input: HandoffEnrichmentInput,
  deps: HandoffEnrichmentDeps,
  options: HandoffEnrichmentOptions = {},
): Promise<string> {
  try {
    const contextMap = await deps.readText(CONTEXT_MAP_PATH);
    const explicitPaths = extractPaths(`${input.title}\n${input.body}`);
    const context = resolveContext(parseContextMap(contextMap), input, explicitPaths);
    if (!context) return "";
    const slug = posix.basename(posix.dirname(context.path)).toLocaleLowerCase("en-US");
    const relevantPaths = [...explicitPaths, `apps/${slug}`, `plugins/${slug}`]
      .filter((path, index, all) => all.indexOf(path) === index)
      .slice(0, MAX_PATHS);
    const issueText = [input.title, input.body, input.labels.join(" ")].join("\n").toLocaleLowerCase("en-US");
    const glossary = await deps.readText(context.path);
    const terms = parseGlossary(glossary, issueText);
    const exemplars = parseExemplars(await deps.gitLog(relevantPaths), relevantPaths);
    return renderBounded(context, terms, exemplars, Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES));
  } catch {
    return "";
  }
}
