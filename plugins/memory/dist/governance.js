import { buildLintRuleSuggestions, lintMemoryRecords, } from "./lint.js";
import { privacyReport, } from "./privacy.js";
import { listContradictions, } from "./supersession.js";
export async function buildMemoryGovernanceReport(store, opts = {}) {
    const [nodes, rawEdges] = await Promise.all([store.listNodes(opts.now), store.listEdges()]);
    const edges = rawEdges.map(toGovernanceEdge);
    const superseded = await store.supersededByMany(nodes.map((node) => node.rid));
    const contradictions = await listContradictions(store, { includeResolved: true });
    const privacy = privacyReport("graph", graphPrivacyRecords(nodes, edges));
    const lintFindings = lintMemoryRecords(nodes.map(graphNodeToLintRecord), { now: opts.now, staleProgressDays: opts.staleProgressDays });
    const lint = {
        status: "ok",
        mode: "graph",
        readOnly: true,
        totalMemories: nodes.length,
        findings: lintFindings,
        ruleSuggestions: buildLintRuleSuggestions(lintFindings),
        warnings: [],
    };
    const provenance = provenanceCoverage(nodes);
    const unresolved = contradictions.filter((item) => !item.resolved).length;
    const resolved = contradictions.length - unresolved;
    const auditEdges = edges.filter((edge) => ["CONTRADICTS", "SUPERSEDED_BY", "TOUCHED"].includes(edge.label)).length;
    const summary = {
        total_nodes: nodes.length,
        total_edges: edges.length,
        nodes_with_provenance: nodes.length - provenance.missing.length,
        missing_provenance: provenance.missing.length,
        privacy_findings: privacy.findings.length,
        lint_findings: lint.findings.length,
        unresolved_contradictions: unresolved,
        resolved_contradictions: resolved,
        superseded_nodes: superseded.size,
        audit_edges: auditEdges,
    };
    return {
        schema_version: "memory.governance.v1",
        read_only: true,
        generated_at: new Date(opts.now ?? Date.now()).toISOString(),
        status: governanceStatus(summary, privacy, lint),
        summary,
        provenance,
        privacy,
        lint,
        contradictions,
        supersession: [...superseded.entries()]
            .map(([rid, activeRid]) => ({ rid, active_rid: activeRid }))
            .sort((a, b) => a.rid - b.rid),
        recommended_next_actions: recommendations(summary, privacy, lint),
    };
}
function governanceStatus(summary, privacy, lint) {
    if (privacy.status === "degraded" || lint.status === "degraded")
        return "degraded";
    if (privacy.findings.some((finding) => finding.severity === "error"))
        return "degraded";
    if (lint.findings.some((finding) => finding.severity === "error"))
        return "degraded";
    if (summary.unresolved_contradictions > 0 ||
        summary.privacy_findings > 0 ||
        summary.lint_findings > 0 ||
        summary.missing_provenance > 0) {
        return "attention";
    }
    return "ok";
}
function recommendations(summary, privacy, lint) {
    const out = [];
    if (summary.privacy_findings > 0) {
        out.push("inspect `memory privacy scan --json` before exporting or sharing Memory artifacts");
    }
    if (summary.unresolved_contradictions > 0) {
        out.push("resolve or supersede contradictory Memory evidence before relying on related guidance");
    }
    if (summary.missing_provenance > 0) {
        out.push("add provenance metadata to high-value nodes with missing writer/source evidence");
    }
    if (lint.findings.length > 0) {
        out.push("review `memory lint --json` findings before adding more durable guidance");
    }
    if (privacy.warnings.length > 0 || lint.warnings.length > 0) {
        out.push("investigate governance warnings before treating the report as complete");
    }
    return [...new Set(out)];
}
function provenanceCoverage(nodes) {
    const byKind = new Map();
    const missing = [];
    for (const node of nodes) {
        const provenance = provenanceObject(node.properties.provenance);
        const sourceKind = stringValue(provenance?.source_kind);
        if (!provenance || !sourceKind) {
            missing.push({
                rid: node.rid,
                label: node.label,
                node_type: node.node_type,
                title: String(node.properties.title ?? node.label),
            });
            continue;
        }
        byKind.set(sourceKind, (byKind.get(sourceKind) ?? 0) + 1);
    }
    return {
        coverage: nodes.length === 0 ? 1 : (nodes.length - missing.length) / nodes.length,
        by_source_kind: [...byKind.entries()]
            .map(([source_kind, count]) => ({ source_kind, count }))
            .sort((a, b) => b.count - a.count || a.source_kind.localeCompare(b.source_kind)),
        missing: missing.slice(0, 20),
    };
}
function graphPrivacyRecords(nodes, edges) {
    return [
        ...nodes.map((node) => ({
            id: `memory_nodes:${node.rid}`,
            location: `memory_nodes:${node.rid}`,
            fields: {
                label: node.label,
                node_type: node.node_type,
                properties: node.properties,
            },
        })),
        ...edges.map((edge) => ({
            id: `memory_edges:${edge.rid}`,
            location: `memory_edges:${edge.rid}`,
            fields: {
                label: edge.label,
                properties: edge.properties,
            },
        })),
    ];
}
function graphNodeToLintRecord(node) {
    const props = node.properties;
    return {
        id: `memory_nodes:${node.rid}`,
        location: `memory_nodes:${node.rid}`,
        title: String(props.title ?? node.label),
        body: String(props.content ?? props.summary ?? props.title ?? node.label),
        scope: parseScope(props.scope),
        tier: parseTier(props.tier),
        createdAt: parseTime(props.created_at),
        updatedAt: parseTime(props.updated_at),
    };
}
function toGovernanceEdge(edge) {
    return {
        rid: Number(edge.rid ?? edge.red_entity_id ?? 0),
        label: String(edge.label ?? edge.edge_label ?? edge.LABEL ?? ""),
        from: Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM),
        to: Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO),
        properties: recordValue(edge.properties ?? edge.PROPERTIES),
    };
}
function provenanceObject(value) {
    return value != null && typeof value === "object" ? value : null;
}
function recordValue(value) {
    return value != null && typeof value === "object" ? value : {};
}
function stringValue(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function parseScope(value) {
    return [
        "user",
        "project",
        "repo",
        "branch",
        "worktree",
        "session",
        "agent-run",
    ].includes(value)
        ? value
        : undefined;
}
function parseTier(value) {
    return value === "durable" || value === "ephemeral" || value === "reasoning"
        ? value
        : undefined;
}
function parseTime(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
