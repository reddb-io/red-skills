import { PINNED_IMPORTANCE_THRESHOLD } from "./doctor.js";
import { recall } from "./engine.js";
const DEFAULT_LIMIT = 12;
const DEFAULT_MIN_EVIDENCE = 2;
const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const SECTION_TITLES = {
    priorDecisions: "Prior Decisions",
    constraints: "Constraints",
    pitfalls: "Pitfalls",
    validations: "Validations",
    impactedConcepts: "Impacted Concepts",
};
const SECTION_ORDER = [
    "priorDecisions",
    "constraints",
    "pitfalls",
    "validations",
    "impactedConcepts",
];
export async function buildPreflightBrief(store, task, opts = {}) {
    const now = opts.now ?? Date.now();
    const minEvidence = opts.minEvidence ?? DEFAULT_MIN_EVIDENCE;
    const accessRecords = await store.accessRecords();
    const recalled = await recall(store, task, {
        k: opts.limit ?? DEFAULT_LIMIT,
        depth: opts.depth ?? 1,
        includeSuperseded: true,
        scope: opts.scope,
        now,
    });
    const rids = recalled.nodes.map((node) => node.rid);
    const superseded = await store.supersededByMany(rids);
    const warnings = await buildWarnings(store, recalled.nodes, superseded, accessRecords, {
        now,
        staleDays: opts.staleDays ?? DEFAULT_STALE_DAYS,
        minEvidence,
    });
    const warningRids = warningRidIndex(warnings);
    const evidence = recalled.nodes.map((node, index) => toEvidence(node, index + 1, task, statusesFor(node.rid, superseded, warningRids)));
    const activeEvidence = evidence.filter((item) => item.statuses.includes("active"));
    const sections = emptySections();
    for (const item of activeEvidence) {
        sections[classifySection(item)].push(stripStatuses(item));
    }
    for (const section of SECTION_ORDER) {
        sections[section].sort((a, b) => b.score - a.score || a.rid - b.rid);
    }
    const missingEvidence = activeEvidence.length < minEvidence;
    const status = missingEvidence
        ? "needs-evidence"
        : warnings.length > 0
            ? "review-warnings"
            : "ready";
    const brief = {
        task,
        status,
        summary: {
            evidenceCount: evidence.length,
            activeEvidenceCount: activeEvidence.length,
            warningCount: warnings.length,
            missingEvidence,
        },
        sections,
        evidence,
        warnings,
        markdown: "",
    };
    return { ...brief, markdown: renderBrief(brief) };
}
async function buildWarnings(store, nodes, superseded, accessRecords, opts) {
    const recalledRids = new Set(nodes.map((node) => node.rid));
    const activeNodes = nodes.filter((node) => !superseded.has(node.rid));
    const warnings = [];
    if (activeNodes.length < opts.minEvidence) {
        warnings.push({
            kind: "missing-evidence",
            message: `Only ${activeNodes.length} active Memory evidence item(s) matched; at least ${opts.minEvidence} are expected for a task preflight.`,
            rids: activeNodes.map((node) => node.rid),
        });
    }
    for (const [from, to] of [...superseded.entries()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
        if (!recalledRids.has(from))
            continue;
        warnings.push({
            kind: "superseded",
            message: `memory_nodes:${from} is superseded by memory_nodes:${to}; prefer the active successor.`,
            rids: [from, to],
        });
    }
    for (const edge of await store.listEdges()) {
        if (edgeLabel(edge) !== "CONTRADICTS")
            continue;
        const from = edgeEndpoint(edge, "from");
        const to = edgeEndpoint(edge, "to");
        if (!recalledRids.has(from) && !recalledRids.has(to))
            continue;
        warnings.push({
            kind: "contradiction",
            message: `memory_nodes:${from} contradicts memory_nodes:${to}${edgeReason(edge)}.`,
            rids: [from, to],
        });
    }
    const stale = staleRecalledNodes(nodes, accessRecords, opts);
    for (const node of stale) {
        warnings.push({
            kind: "stale",
            message: `memory_nodes:${node.rid} has not been recalled in ${node.ageDays} day(s); verify before relying on it.`,
            rids: [node.rid],
        });
    }
    const order = {
        "missing-evidence": 0,
        superseded: 1,
        contradiction: 2,
        stale: 3,
    };
    return warnings.sort((a, b) => order[a.kind] - order[b.kind] || (a.rids[0] ?? 0) - (b.rids[0] ?? 0));
}
function staleRecalledNodes(nodes, access, opts) {
    const cutoff = opts.staleDays * MS_PER_DAY;
    const stale = [];
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
        const age = opts.now - accessedAt;
        if (age < cutoff)
            continue;
        stale.push({ rid: node.rid, ageDays: Math.floor(age / MS_PER_DAY) });
    }
    return stale.sort((a, b) => b.ageDays - a.ageDays || a.rid - b.rid);
}
function warningRidIndex(warnings) {
    const index = new Map();
    for (const warning of warnings) {
        const status = warning.kind === "stale"
            ? "stale"
            : warning.kind === "contradiction"
                ? "contradictory"
                : null;
        if (!status)
            continue;
        for (const rid of warning.rids) {
            const set = index.get(rid) ?? new Set();
            set.add(status);
            index.set(rid, set);
        }
    }
    return index;
}
function statusesFor(rid, superseded, warningRids) {
    const statuses = new Set();
    statuses.add(superseded.has(rid) ? "superseded" : "active");
    for (const status of warningRids.get(rid) ?? [])
        statuses.add(status);
    return [...statuses];
}
function toEvidence(node, marker, task, statuses) {
    const title = node.properties.title ?? node.label;
    const source = typeof node.properties.source === "string" ? node.properties.source : null;
    return {
        citation: `[M${marker}]`,
        urn: `memory_nodes:${node.rid}`,
        rid: node.rid,
        title,
        nodeType: node.node_type,
        confidence: node.properties.confidence ?? "AMBIGUOUS",
        source,
        excerpt: normalizeWhitespace(node.excerpt),
        reason: `${sectionReason(classifyNode(node))} matched "${task}" with recall score ${node.score.toFixed(4)}.`,
        score: node.score,
        statuses,
    };
}
function stripStatuses(item) {
    const { statuses: _statuses, ...rest } = item;
    return rest;
}
function emptySections() {
    return {
        priorDecisions: [],
        constraints: [],
        pitfalls: [],
        validations: [],
        impactedConcepts: [],
    };
}
function classifySection(item) {
    return classifyText(item.nodeType, `${item.title} ${item.excerpt}`);
}
function classifyNode(node) {
    return classifyText(node.node_type, `${node.properties.title ?? ""} ${node.properties.summary ?? ""} ${node.properties.content ?? ""} ${(node.properties.tags ?? []).join(" ")}`);
}
function classifyText(nodeType, text) {
    const lower = text.toLowerCase();
    if (nodeType === "validation" ||
        /\b(validation|validated|test|typecheck|lint|build|check)\b/.test(lower)) {
        return "validations";
    }
    if (nodeType === "decision" || /\b(decision|decided|choose|chose|chosen)\b/.test(lower)) {
        return "priorDecisions";
    }
    if (nodeType === "problem" ||
        /\b(pitfall|failure|bug|risk|regression|error|incident|gotcha)\b/.test(lower)) {
        return "pitfalls";
    }
    if (/\b(must|required|requires|constraint|invariant|policy|rule|never|avoid|do not|must not)\b/.test(lower)) {
        return "constraints";
    }
    return "impactedConcepts";
}
function sectionReason(section) {
    const reasons = {
        priorDecisions: "decision evidence",
        constraints: "constraint evidence",
        pitfalls: "pitfall or risk evidence",
        validations: "validation evidence",
        impactedConcepts: "related concept evidence",
    };
    return reasons[section];
}
function renderBrief(brief) {
    const lines = [`# Memory preflight: ${brief.task}`, "", `Status: ${brief.status}`, ""];
    if (brief.warnings.length > 0) {
        lines.push("## Warnings");
        for (const warning of brief.warnings)
            lines.push(`- ${warning.kind}: ${warning.message}`);
        lines.push("");
    }
    for (const section of SECTION_ORDER) {
        const items = brief.sections[section];
        if (items.length === 0)
            continue;
        lines.push(`## ${SECTION_TITLES[section]}`);
        for (const item of items) {
            const source = item.source ? `; source: ${item.source}` : "";
            lines.push(`- ${item.citation} ${item.title} (${item.nodeType}, ${item.confidence}; urn: ${item.urn}${source})`);
            lines.push(`  Reason: ${item.reason}`);
            lines.push(`  Evidence: ${item.excerpt}`);
        }
        lines.push("");
    }
    if (brief.evidence.length === 0)
        lines.push("_No relevant Memory evidence matched this task._", "");
    return lines.join("\n");
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
function normalizeWhitespace(text) {
    return text.replace(/\s+/g, " ").trim().slice(0, 240);
}
