import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";
import { contentHash } from "./hash.js";
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const MARKDOWN_LINK_RE = /(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const INLINE_CODE_RE = /`([A-Za-z][A-Za-z0-9_:.#/-]{2,})`/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;
/**
 * Markdown extraction (the deterministic `EXTRACTED` path).
 *
 * Ported from red-memory `packages/extractor/src/markdown.ts`. Pure structural
 * parse, no LLM calls:
 *   - one root `concept` node for the file, plus one per h1–h3 heading
 *   - the underlying doc chunk (body + frontmatter) for later FTS/ASK
 *   - deterministic referenced-entity nodes from `[[wiki-link]]`, explicit
 *     markdown links, and inline code identifiers, with `REFERENCES` edges from
 *     the source file
 */
export async function extractMarkdown(path) {
    const raw = await readFile(path, "utf8");
    const parsed = matter(raw);
    const fm = parsed.data;
    const body = parsed.content;
    const hash = contentHash(path, raw);
    const updated_at = Date.now();
    const title = fm.title ?? deriveTitle(body) ?? basename(path);
    const tags = (fm.tags ?? []).map(String);
    const doc = { path, title, body, frontmatter: fm, hash, updated_at };
    const nodes = [];
    const seenHeadings = new Set();
    // Root concept node for the file.
    nodes.push({
        label: `md:${path}`,
        node_type: "concept",
        properties: {
            title,
            summary: deriveSummary(body),
            tags,
            source: path,
            confidence: "EXTRACTED",
            provenance: {
                source_kind: "derived",
                writer: "extract-markdown",
                confidence: "EXTRACTED",
                evidence: [path],
            },
            hash,
        },
    });
    for (const match of body.matchAll(HEADING_RE)) {
        const level = match[1]?.length ?? 1;
        const text = match[2]?.trim();
        if (!text || level > 3)
            continue;
        const slug = slugify(text);
        if (seenHeadings.has(slug))
            continue;
        seenHeadings.add(slug);
        nodes.push({
            label: `md:${path}#${slug}`,
            node_type: "concept",
            properties: {
                title: text,
                source: `${path}#${slug}`,
                confidence: "EXTRACTED",
                provenance: {
                    source_kind: "derived",
                    writer: "extract-markdown",
                    confidence: "EXTRACTED",
                    evidence: [`${path}#${slug}`],
                },
                hash: contentHash(path, slug, text),
            },
        });
    }
    const edges = [];
    const entities = referencedEntities(body);
    for (const entity of entities) {
        const label = entityLabel(entity.title);
        nodes.push({
            label,
            node_type: "concept",
            properties: {
                title: entity.title,
                summary: `Referenced ${entity.kind} in ${path}`,
                tags: ["entity", entity.kind],
                source: path,
                confidence: "EXTRACTED",
                provenance: {
                    source_kind: "derived",
                    writer: "extract-markdown",
                    confidence: "EXTRACTED",
                    evidence: entity.evidence,
                },
                entity_kind: entity.kind,
                hash: contentHash(path, "entity", entity.kind, entity.title),
            },
        });
        edges.push({ fromHash: hash, toLabel: label, label: "REFERENCES" });
    }
    return { doc, nodes, edges };
}
function referencedEntities(body) {
    const byKey = new Map();
    const add = (title, kind, evidence) => {
        const cleaned = cleanEntityTitle(title);
        if (!cleaned)
            return;
        if (kind === "link" ? !looksLikeLinkEntity(cleaned) : !looksLikeEntity(cleaned))
            return;
        const key = `${kind}:${cleaned.toLowerCase()}`;
        const current = byKey.get(key);
        if (current) {
            current.evidence.push(evidence);
            return;
        }
        byKey.set(key, { title: cleaned, kind, evidence: [evidence] });
    };
    for (const link of body.matchAll(WIKILINK_RE)) {
        const target = link[1]?.trim();
        if (target)
            add(target, "wikilink", `[[${target}]]`);
    }
    for (const link of body.matchAll(MARKDOWN_LINK_RE)) {
        const target = link[2]?.trim();
        if (target)
            add(cleanLinkTarget(target), "link", link[0] ?? target);
    }
    for (const code of body.matchAll(INLINE_CODE_RE)) {
        const target = code[1]?.trim();
        if (target)
            add(target, "identifier", `\`${target}\``);
    }
    return [...byKey.values()].sort((a, b) => a.title.localeCompare(b.title));
}
function cleanEntityTitle(value) {
    return value.replace(/^#/, "").trim().slice(0, 120);
}
function cleanLinkTarget(value) {
    return value
        .replace(/^<|>$/g, "")
        .replace(/#.*$/, "")
        .trim()
        .slice(0, 120);
}
function looksLikeEntity(value) {
    if (value.length < 3)
        return false;
    if (/^[./-]/.test(value))
        return false;
    if (/^\d+$/.test(value))
        return false;
    return /[A-Z_:.#/-]/.test(value);
}
function looksLikeLinkEntity(value) {
    if (value.length < 3)
        return false;
    if (/^\d+$/.test(value))
        return false;
    return (/^https?:\/\//i.test(value) ||
        value.includes("/") ||
        /\.(?:md|mdx|txt|json|ya?ml|toml|ts|tsx|js|jsx|py|go|rs|sql|sh)$/i.test(value));
}
function entityLabel(title) {
    return `entity:${entitySlugify(title) || contentHash("entity", title)}`;
}
function entitySlugify(text) {
    return text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-z0-9_:.#/-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);
}
function deriveTitle(body) {
    const m = body.match(/^#\s+(.+)$/m);
    return m?.[1]?.trim();
}
function deriveSummary(body) {
    const stripped = body.replace(/^#.*$/gm, "").trim();
    const firstPara = stripped.split(/\n\s*\n/)[0];
    return firstPara?.slice(0, 280);
}
function slugify(text) {
    return text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80);
}
