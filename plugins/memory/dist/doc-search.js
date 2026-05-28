const DEFAULT_DOC_READ_MAX_BYTES = 20_000;
export async function searchDocs(store, query, opts = {}) {
    const terms = tokenize(query);
    const docs = await store.listDocs();
    if (terms.length === 0)
        return { query, total_docs: docs.length, hits: [] };
    const hits = docs
        .map((doc) => scoreDoc(doc, terms))
        .filter((hit) => hit != null)
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, opts.limit ?? 10);
    return { query, total_docs: docs.length, hits };
}
export async function readDoc(store, input) {
    const docs = await store.listDocs();
    const byRid = input.rid != null ? docs.find((doc) => doc.rid === input.rid) : undefined;
    const byPath = byRid == null && input.path ? docs.find((doc) => doc.path === input.path) : undefined;
    const doc = byRid ?? byPath;
    if (!doc) {
        return {
            found: false,
            matched_by: null,
            rid: input.rid ?? null,
            path: input.path ?? null,
            title: null,
            body: "",
            body_length: 0,
            body_bytes: 0,
            returned_bytes: 0,
            truncated: false,
            frontmatter: null,
            hash: null,
            updated_at: null,
        };
    }
    const maxBytes = input.max_bytes ?? DEFAULT_DOC_READ_MAX_BYTES;
    const body = truncateUtf8(doc.body, maxBytes);
    return {
        found: true,
        matched_by: byRid ? "rid" : "path",
        rid: doc.rid,
        path: doc.path,
        title: doc.title ?? null,
        body,
        body_length: doc.body.length,
        body_bytes: Buffer.byteLength(doc.body, "utf8"),
        returned_bytes: Buffer.byteLength(body, "utf8"),
        truncated: body.length !== doc.body.length,
        frontmatter: doc.frontmatter ?? null,
        hash: doc.hash,
        updated_at: doc.updated_at,
    };
}
function scoreDoc(doc, terms) {
    const fields = {
        path: doc.path,
        title: doc.title ?? "",
        frontmatter: JSON.stringify(doc.frontmatter ?? {}),
        body: doc.body,
    };
    const matched_fields = [];
    let score = 0;
    for (const [field, value] of Object.entries(fields)) {
        const tokens = tokenize(value);
        let fieldScore = 0;
        for (const token of tokens) {
            if (terms.includes(token))
                fieldScore += 1;
        }
        if (fieldScore > 0) {
            matched_fields.push(field);
            score += fieldScore * fieldWeight(field);
        }
    }
    if (score === 0)
        return null;
    return {
        rid: doc.rid,
        path: doc.path,
        title: doc.title ?? null,
        score,
        excerpt: excerpt(doc, terms),
        matched_fields,
        body_length: doc.body.length,
        updated_at: doc.updated_at,
    };
}
function fieldWeight(field) {
    switch (field) {
        case "title":
            return 4;
        case "path":
            return 3;
        case "frontmatter":
            return 2;
        case "body":
            return 1;
    }
}
function excerpt(doc, terms) {
    const haystack = doc.body.replace(/\s+/g, " ").trim();
    if (!haystack)
        return doc.title ?? doc.path;
    const lower = haystack.toLowerCase();
    const first = terms
        .map((term) => lower.indexOf(term))
        .filter((index) => index >= 0)
        .sort((a, b) => a - b)[0];
    const start = Math.max(0, (first ?? 0) - 80);
    const end = Math.min(haystack.length, start + 240);
    const prefix = start > 0 ? "..." : "";
    const suffix = end < haystack.length ? "..." : "";
    return `${prefix}${haystack.slice(start, end)}${suffix}`;
}
function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9_:/.-]+/g) ?? []).filter(Boolean);
}
function truncateUtf8(text, maxBytes) {
    if (maxBytes <= 0)
        return "";
    if (Buffer.byteLength(text, "utf8") <= maxBytes)
        return text;
    let bytes = 0;
    let end = 0;
    for (const char of text) {
        const next = bytes + Buffer.byteLength(char, "utf8");
        if (next > maxBytes)
            break;
        bytes = next;
        end += char.length;
    }
    return text.slice(0, end);
}
