const DEFAULT_LIMIT = 20;
const SECTION_LIMIT = 5;
export async function buildMemoryHandoff(store, input = {}) {
    const now = input.now ?? Date.now();
    const focus = normalizeFocus(input.focus);
    const limit = clampLimit(input.limit);
    const nodes = await store.listNodes(now);
    const ranked = rankNodes(nodes, focus, now).slice(0, limit);
    const sections = buildSections(ranked, now);
    const returnedItems = sections.reduce((sum, section) => sum + section.items.length, 0);
    const report = {
        schema_version: "memory.handoff.v1",
        read_only: true,
        generated_at: new Date(now).toISOString(),
        focus,
        status: returnedItems > 0 ? "ready" : "empty",
        summary: {
            considered_nodes: nodes.length,
            returned_items: returnedItems,
            active_work: sectionCount(sections, "active-work"),
            decisions: sectionCount(sections, "decisions"),
            validations: sectionCount(sections, "validations"),
            risks: sectionCount(sections, "risks"),
            context: sectionCount(sections, "context"),
        },
        sections,
        recommended_next_actions: nextActions(returnedItems, focus),
    };
    return { ...report, markdown: renderMarkdown(report) };
}
function rankNodes(nodes, focus, now) {
    const terms = focusTerms(focus);
    return nodes
        .map((node) => ({ node, score: scoreNode(node, terms, now) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score ||
        nodeTime(b.node) - nodeTime(a.node) ||
        String(a.node.properties.title ?? a.node.label).localeCompare(String(b.node.properties.title ?? b.node.label)));
}
function scoreNode(node, terms, now) {
    const typeScore = {
        task: 10,
        goal: 10,
        issue: 9,
        prd: 8,
        attempt: 8,
        decision: 8,
        validation: 7,
        problem: 7,
        why_note: 6,
        workflow: 5,
        concept: 4,
        file: 3,
        solution: 5,
        fix: 5,
        import: 1,
        person: 1,
        session: 5,
        symbol: 2,
        transcript: 2,
    };
    const haystack = nodeText(node).toLowerCase();
    const focusScore = terms.length === 0
        ? 1
        : terms.reduce((score, term) => score + (haystack.includes(term) ? 4 : 0), 0);
    if (terms.length > 0 && focusScore === 0)
        return 0;
    const ageDays = Math.max(0, (now - nodeTime(node)) / 86_400_000);
    const recency = Math.max(0, 4 - Math.min(4, ageDays / 7));
    const importance = typeof node.properties.importance === "number" ? node.properties.importance : 0.5;
    return typeScore[node.node_type] + focusScore + recency + importance;
}
function buildSections(ranked, now) {
    const activeWork = section("active-work", "Active Work", ranked, now, [
        "task",
        "goal",
        "issue",
        "prd",
        "attempt",
        "session",
    ]);
    const decisions = section("decisions", "Recent Decisions", ranked, now, ["decision"]);
    const validations = section("validations", "Validation Evidence", ranked, now, [
        "validation",
    ]);
    const risks = section("risks", "Known Risks And Why Notes", ranked, now, [
        "problem",
        "why_note",
    ]);
    const context = section("context", "Relevant Context", ranked, now, [
        "workflow",
        "concept",
        "solution",
        "fix",
        "file",
    ]);
    return [activeWork, decisions, validations, risks, context].filter((item) => item.items.length > 0);
}
function section(id, title, ranked, now, types) {
    return {
        id,
        title,
        items: ranked
            .filter((item) => types.includes(item.node.node_type))
            .slice(0, SECTION_LIMIT)
            .map((item) => toItem(item.node, now)),
    };
}
function toItem(node, now) {
    const timestamp = nodeTime(node);
    const updatedAt = timestamp > 0 ? new Date(timestamp).toISOString() : null;
    return {
        rid: node.rid,
        label: node.label,
        node_type: node.node_type,
        title: stringProp(node.properties.title) ?? node.label,
        summary: summarizeNode(node),
        source: stringProp(node.properties.source),
        updated_at: updatedAt,
        age_days: timestamp > 0 ? Math.max(0, Math.floor((now - timestamp) / 86_400_000)) : null,
        citation: `${node.node_type}:${node.label}#${node.rid}`,
    };
}
function renderMarkdown(report) {
    const lines = [
        "# Memory handoff",
        "",
        report.focus ? `Focus: ${report.focus}` : "Focus: latest project memory",
        `Status: ${report.status}`,
        "",
    ];
    if (report.sections.length === 0) {
        lines.push("No Memory evidence matched this handoff request.", "");
    }
    for (const section of report.sections) {
        lines.push(`## ${section.title}`);
        for (const item of section.items) {
            const age = item.age_days == null ? "" : ` (${item.age_days}d old)`;
            lines.push(`- ${item.title}${age} — ${item.summary} [${item.citation}]`);
        }
        lines.push("");
    }
    if (report.recommended_next_actions.length > 0) {
        lines.push("## Next Actions");
        for (const action of report.recommended_next_actions)
            lines.push(`- ${action}`);
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
function nextActions(returnedItems, focus) {
    if (returnedItems === 0 && focus) {
        return ["run `memory recall <focus>` or broaden the handoff focus if the next agent needs more context"];
    }
    if (returnedItems === 0) {
        return ["store or bootstrap durable project context before relying on Memory handoff"];
    }
    return ["paste the markdown into the next agent session or call memory_handoff from MCP SessionStart rules"];
}
function sectionCount(sections, id) {
    return sections.find((section) => section.id === id)?.items.length ?? 0;
}
function nodeTime(node) {
    const updated = numberProp(node.properties.updated_at);
    const created = numberProp(node.properties.created_at);
    return updated ?? created ?? 0;
}
function summarizeNode(node) {
    const text = stringProp(node.properties.summary) ??
        stringProp(node.properties.content) ??
        stringProp(node.properties.title) ??
        node.label;
    return compact(text, 220);
}
function nodeText(node) {
    return [
        node.label,
        node.node_type,
        stringProp(node.properties.title),
        stringProp(node.properties.summary),
        stringProp(node.properties.content),
        ...(Array.isArray(node.properties.tags) ? node.properties.tags : []),
    ]
        .filter((part) => typeof part === "string")
        .join(" ");
}
function focusTerms(focus) {
    if (!focus)
        return [];
    return [
        ...new Set(focus
            .toLowerCase()
            .split(/[^a-z0-9_./-]+/i)
            .map((term) => term.trim())
            .filter((term) => term.length >= 2)),
    ];
}
function normalizeFocus(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}
function clampLimit(value) {
    if (value == null || !Number.isFinite(value))
        return DEFAULT_LIMIT;
    return Math.max(1, Math.min(100, Math.floor(value)));
}
function compact(value, max) {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
function stringProp(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function numberProp(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
