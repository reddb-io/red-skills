import { PINNED_IMPORTANCE_THRESHOLD } from "./doctor.js";
const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const SECTION_TITLES = {
    concepts: "Concepts",
    workflows: "Workflows",
    decisions: "Decisions",
    risks: "Risks",
    validations: "Validations",
    suggestedSkills: "Suggested Skills",
};
const SECTION_ORDER = [
    "concepts",
    "workflows",
    "decisions",
    "risks",
    "validations",
    "suggestedSkills",
];
const NODE_SECTION = {
    concept: "concepts",
    workflow: "workflows",
    decision: "decisions",
    problem: "risks",
    validation: "validations",
};
export async function buildOnboardingMap(store, opts = {}) {
    const now = opts.now ?? Date.now();
    const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
    const nodes = (await store.listNodes()).sort((a, b) => a.rid - b.rid);
    const edges = await store.listEdges();
    const superseded = await store.supersededByMany(nodes.map((node) => node.rid));
    const access = await store.accessRecords();
    const contradictionRids = contradictionRidSet(edges);
    const stale = staleRidSet(nodes, access, now, staleDays);
    const warnings = buildWarnings(nodes, edges, superseded, stale);
    const sections = emptySections();
    let marker = 1;
    for (const node of nodes) {
        const section = NODE_SECTION[node.node_type];
        if (!section)
            continue;
        sections[section].push(toEvidenceItem(node, marker++, statusesFor(node.rid, superseded, stale, contradictionRids)));
    }
    sections.suggestedSkills.push(...skillSuggestions(opts.rollups ?? []));
    const summary = {
        concepts: sections.concepts.length,
        workflows: sections.workflows.length,
        decisions: sections.decisions.length,
        risks: sections.risks.length,
        validations: sections.validations.length,
        suggestedSkills: sections.suggestedSkills.length,
        warnings: warnings.length,
    };
    const evidenceCount = summary.concepts +
        summary.workflows +
        summary.decisions +
        summary.risks +
        summary.validations +
        summary.suggestedSkills;
    const status = evidenceCount === 0 ? "empty" : warnings.length > 0 ? "review-warnings" : "ready";
    const withoutMarkdown = { status, summary, sections, warnings };
    return {
        schema_version: "memory.onboarding_map.v1",
        read_only: true,
        ...withoutMarkdown,
        markdown: renderOnboardingMap(withoutMarkdown),
    };
}
function emptySections() {
    return {
        concepts: [],
        workflows: [],
        decisions: [],
        risks: [],
        validations: [],
        suggestedSkills: [],
    };
}
function toEvidenceItem(node, marker, statuses) {
    return {
        citation: `[M${marker}]`,
        urn: urn(node.rid),
        rid: node.rid,
        title: titleOf(node),
        nodeType: node.node_type,
        confidence: node.properties.confidence ?? "AMBIGUOUS",
        source: typeof node.properties.source === "string" ? node.properties.source : null,
        excerpt: normalizeWhitespace(String(node.properties.summary ?? node.properties.content ?? "")),
        statuses,
    };
}
function statusesFor(rid, superseded, stale, contradictory) {
    const statuses = new Set();
    statuses.add(superseded.has(rid) ? "superseded" : "active");
    if (stale.has(rid))
        statuses.add("stale");
    if (contradictory.has(rid))
        statuses.add("contradictory");
    return [...statuses];
}
function skillSuggestions(rollups) {
    return rollups
        .filter((rollup) => rollup.use_count > 0 || rollup.result_count > 0)
        .sort((a, b) => {
        const activity = Date.parse(b.last_activity) - Date.parse(a.last_activity);
        return activity !== 0 ? activity : a.name.localeCompare(b.name);
    })
        .map((rollup, index) => {
        const succeeded = Number(rollup.outcome_counts.succeeded ?? 0);
        const failed = Number(rollup.outcome_counts.failed ?? 0) +
            Number(rollup.outcome_counts.blocked ?? 0) +
            Number(rollup.outcome_counts.abandoned ?? 0);
        return {
            citation: `[S${index + 1}]`,
            name: rollup.name,
            sourceKind: rollup.source_kind,
            path: rollup.path,
            evidence: `skill-rollup:${rollup.name}`,
            lastActivity: rollup.last_activity,
            useCount: rollup.use_count,
            resultCount: rollup.result_count,
            succeeded,
            failed,
            reason: `${rollup.name} has Memory skill telemetry with ${rollup.use_count} use(s) and ${rollup.result_count} result(s).`,
        };
    });
}
function buildWarnings(nodes, edges, superseded, stale) {
    const known = new Set(nodes.map((node) => node.rid));
    const warnings = [];
    for (const [from, to] of [...superseded.entries()].sort((a, b) => a[0] - b[0])) {
        warnings.push({
            kind: "superseded",
            message: `${urn(from)} is superseded by ${urn(to)}; keep both visible while onboarding.`,
            rids: [from, to],
        });
    }
    for (const edge of edges) {
        if (edgeLabel(edge) !== "CONTRADICTS")
            continue;
        const from = edgeEndpoint(edge, "from");
        const to = edgeEndpoint(edge, "to");
        if (!known.has(from) && !known.has(to))
            continue;
        warnings.push({
            kind: "contradiction",
            message: `${urn(from)} contradicts ${urn(to)}${edgeReason(edge)}.`,
            rids: [from, to],
        });
    }
    for (const rid of [...stale].sort((a, b) => a - b)) {
        warnings.push({
            kind: "stale",
            message: `${urn(rid)} has not been recalled recently; verify before relying on it.`,
            rids: [rid],
        });
    }
    const rank = {
        superseded: 0,
        contradiction: 1,
        stale: 2,
    };
    return warnings.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.rids[0] ?? 0) - (b.rids[0] ?? 0));
}
function staleRidSet(nodes, access, now, staleDays) {
    const cutoff = staleDays * MS_PER_DAY;
    const out = new Set();
    for (const node of nodes) {
        if (node.properties.tier === "ephemeral")
            continue;
        if (Number(node.properties.importance ?? 0) >= PINNED_IMPORTANCE_THRESHOLD)
            continue;
        const overlay = access.get(node.rid);
        const accessCount = overlay?.count ?? Number(node.properties.access_count ?? 0);
        if (accessCount > 0)
            continue;
        const accessedAt = overlay?.accessed_at ?? Number(node.properties.accessed_at ?? node.properties.created_at ?? 0);
        if (now - accessedAt >= cutoff)
            out.add(node.rid);
    }
    return out;
}
function contradictionRidSet(edges) {
    const out = new Set();
    for (const edge of edges) {
        if (edgeLabel(edge) !== "CONTRADICTS")
            continue;
        out.add(edgeEndpoint(edge, "from"));
        out.add(edgeEndpoint(edge, "to"));
    }
    return out;
}
function renderOnboardingMap(report) {
    const lines = [
        "# Memory onboarding map",
        "",
        `Status: ${report.status}`,
        "",
        "Summary:",
        `- Concepts: ${report.summary.concepts}`,
        `- Workflows: ${report.summary.workflows}`,
        `- Decisions: ${report.summary.decisions}`,
        `- Risks: ${report.summary.risks}`,
        `- Validations: ${report.summary.validations}`,
        `- Suggested skills: ${report.summary.suggestedSkills}`,
        `- Warnings: ${report.summary.warnings}`,
        "",
    ];
    if (report.warnings.length > 0) {
        lines.push("## Warnings");
        for (const warning of report.warnings) {
            lines.push(`- ${warning.kind}: ${warning.message}`);
        }
        lines.push("");
    }
    for (const section of SECTION_ORDER) {
        const items = report.sections[section];
        lines.push(`## ${SECTION_TITLES[section]}`);
        if (items.length === 0) {
            lines.push("- none", "");
            continue;
        }
        if (section === "suggestedSkills") {
            for (const item of items) {
                lines.push(`- ${item.citation} ${item.name} (${item.sourceKind}; evidence: ${item.evidence})`);
                lines.push(`  Reason: ${item.reason}`);
            }
            lines.push("");
            continue;
        }
        for (const item of items) {
            const source = item.source ? `; source: ${item.source}` : "";
            lines.push(`- ${item.citation} ${item.title} (${item.nodeType}, ${item.confidence}; urn: ${item.urn}; status: ${item.statuses.join(", ")}${source})`);
            if (item.excerpt)
                lines.push(`  Evidence: ${item.excerpt}`);
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
}
function edgeLabel(edge) {
    return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}
function edgeEndpoint(edge, side) {
    if (side === "from") {
        return Number(edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id ?? 0);
    }
    return Number(edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id ?? 0);
}
function edgeReason(edge) {
    const props = edge.properties;
    if (!props || typeof props !== "object" || !("reason" in props))
        return "";
    const reason = props.reason;
    return reason == null ? "" : ` (${String(reason)})`;
}
function titleOf(node) {
    return String(node.properties.title ?? node.label);
}
function urn(rid) {
    return `memory_nodes:${rid}`;
}
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 240);
}
