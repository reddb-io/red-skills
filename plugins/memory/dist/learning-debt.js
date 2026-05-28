import { PINNED_IMPORTANCE_THRESHOLD } from "./doctor.js";
const DEFAULT_STALE_DAYS = 90;
const DEFAULT_MIN_REPEATED_FAILURES = 2;
const MS_PER_DAY = 86_400_000;
const FAILURE_STATUSES = new Set(["blocked", "failed", "no-sentinel", "merge-conflict"]);
const GUIDANCE_TYPES = new Set(["decision", "workflow", "solution", "fix"]);
const VALIDATION_REQUIRED_TYPES = new Set(["decision", "solution", "fix"]);
const LESSON_TYPES = new Set(["why_note", "problem", "solution", "fix", "workflow"]);
export async function buildLearningDebtReport(store, opts = {}) {
    const now = opts.now ?? Date.now();
    const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
    const minRepeatedFailures = opts.minRepeatedFailures ?? DEFAULT_MIN_REPEATED_FAILURES;
    const nodes = await store.listNodes();
    const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
    const edges = await store.listEdges();
    const superseded = await store.supersededByMany(nodes.map((node) => node.rid));
    const access = await store.accessRecords();
    const activeNodes = nodes.filter((node) => !superseded.has(node.rid));
    const contradictedRids = contradictionRidSet(edges);
    const repeatedFailurePatterns = repeatedFailuresWithoutLessons(activeNodes, nodeByRid, edges, minRepeatedFailures);
    const staleOrContradictedGuidance = [
        ...contradictedGuidance(activeNodes, edges, nodeByRid, superseded),
        ...staleGuidance(activeNodes, access, now, staleDays),
    ].sort(guidanceOrder);
    const missingValidationEvidence = validationGaps(activeNodes, edges, nodeByRid, contradictedRids);
    const skillTelemetryGaps = telemetryGaps(opts.rollups ?? [], opts.skillTelemetryEnabled === true);
    const categories = {
        repeatedFailurePatterns,
        staleOrContradictedGuidance,
        missingValidationEvidence,
        skillTelemetryGaps,
    };
    const summary = {
        repeatedFailurePatterns: repeatedFailurePatterns.length,
        staleOrContradictedGuidance: staleOrContradictedGuidance.length,
        missingValidationEvidence: missingValidationEvidence.length,
        skillTelemetryGaps: skillTelemetryGaps.length,
    };
    const status = Object.values(summary).some((count) => count > 0)
        ? "debt-found"
        : "clean";
    const withoutMarkdown = { status, summary, categories };
    return {
        schema_version: "memory.learning_debt.v1",
        read_only: true,
        ...withoutMarkdown,
        markdown: renderLearningDebtReport(withoutMarkdown),
    };
}
function repeatedFailuresWithoutLessons(nodes, nodeByRid, edges, minRepeatedFailures) {
    const attempts = nodes.filter((node) => {
        if (node.node_type !== "attempt")
            return false;
        return FAILURE_STATUSES.has(stringProp(node, "status").toLowerCase());
    });
    const groups = new Map();
    for (const attempt of attempts) {
        const issue = numberProp(attempt, "issue_number");
        const error = stringProp(attempt, "error_class") || stringProp(attempt, "status") || "unknown";
        const key = `issue:${issue ?? "unknown"} error:${error}`;
        groups.set(key, [...(groups.get(key) ?? []), attempt]);
    }
    const debts = [];
    for (const [pattern, group] of groups) {
        if (group.length < minRepeatedFailures)
            continue;
        const attemptRids = new Set(group.map((node) => node.rid));
        const hasDurableLesson = edges.some((edge) => {
            if (edgeLabel(edge) !== "LEARNED_FROM")
                return false;
            const from = edgeEndpoint(edge, "from");
            const to = edgeEndpoint(edge, "to");
            const otherRid = attemptRids.has(from) ? to : attemptRids.has(to) ? from : null;
            if (otherRid == null)
                return false;
            const other = nodeByRid.get(otherRid);
            return other != null && LESSON_TYPES.has(other.node_type);
        });
        if (hasDurableLesson)
            continue;
        debts.push({
            pattern,
            attemptCount: group.length,
            hasDurableLesson,
            citations: group.map((node) => urn(node.rid)),
            issueNumber: numberProp(group[0], "issue_number"),
            errorClass: stringProp(group[0], "error_class") || "unknown",
            statuses: [...new Set(group.map((node) => stringProp(node, "status")).filter(Boolean))].sort(),
            touchedFiles: [...new Set(group.flatMap((node) => stringArrayProp(node, "touched_files")))].sort(),
        });
    }
    return debts.sort((a, b) => b.attemptCount - a.attemptCount || a.pattern.localeCompare(b.pattern));
}
function contradictedGuidance(nodes, edges, nodeByRid, superseded) {
    const activeGuidance = new Set(nodes
        .filter((node) => GUIDANCE_TYPES.has(node.node_type) && !superseded.has(node.rid))
        .map((node) => node.rid));
    const seen = new Set();
    const debts = [];
    for (const edge of edges) {
        if (edgeLabel(edge) !== "CONTRADICTS")
            continue;
        const from = edgeEndpoint(edge, "from");
        const to = edgeEndpoint(edge, "to");
        const subjectRid = [from, to].filter((rid) => activeGuidance.has(rid)).sort((a, b) => a - b)[0];
        if (subjectRid == null || seen.has(subjectRid))
            continue;
        const subject = nodeByRid.get(subjectRid);
        if (!subject)
            continue;
        const other = subjectRid === from ? to : from;
        debts.push({
            kind: "contradicted-guidance",
            evidence: urn(subjectRid),
            nodeType: subject.node_type,
            title: titleOf(subject),
            contradictedBy: urn(other),
            reason: edgeReason(edge) || `${urn(subjectRid)} contradicts ${urn(other)}`,
        });
        seen.add(subjectRid);
    }
    return debts;
}
function staleGuidance(nodes, access, now, staleDays) {
    const cutoff = staleDays * MS_PER_DAY;
    const debts = [];
    for (const node of nodes) {
        if (!GUIDANCE_TYPES.has(node.node_type))
            continue;
        if (node.properties.tier === "ephemeral")
            continue;
        if (Number(node.properties.importance ?? 0) >= PINNED_IMPORTANCE_THRESHOLD)
            continue;
        const overlay = access.get(node.rid);
        const accessCount = overlay?.count ?? Number(node.properties.access_count ?? 0);
        if (accessCount > 0)
            continue;
        const accessedAt = overlay?.accessed_at ?? Number(node.properties.accessed_at ?? node.properties.created_at ?? 0);
        const age = now - accessedAt;
        if (age < cutoff)
            continue;
        const ageDays = Math.floor(age / MS_PER_DAY);
        debts.push({
            kind: "stale-guidance",
            evidence: urn(node.rid),
            nodeType: node.node_type,
            title: titleOf(node),
            ageDays,
            reason: `${urn(node.rid)} has not been recalled in ${ageDays} day(s)`,
        });
    }
    return debts.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0) || ridOf(a.evidence) - ridOf(b.evidence));
}
function validationGaps(nodes, edges, nodeByRid, contradictedRids) {
    const debts = [];
    for (const node of nodes) {
        if (!VALIDATION_REQUIRED_TYPES.has(node.node_type))
            continue;
        if (contradictedRids.has(node.rid))
            continue;
        if (hasValidationEvidence(node.rid, edges, nodeByRid))
            continue;
        debts.push({
            evidence: urn(node.rid),
            nodeType: node.node_type,
            title: titleOf(node),
            reason: `${urn(node.rid)} has implementation or decision evidence but no linked validation evidence`,
        });
    }
    return debts.sort((a, b) => ridOf(a.evidence) - ridOf(b.evidence));
}
function hasValidationEvidence(rid, edges, nodeByRid) {
    return edges.some((edge) => {
        const label = edgeLabel(edge);
        if (label !== "TESTED_BY" && label !== "CONFIRMS")
            return false;
        const from = edgeEndpoint(edge, "from");
        const to = edgeEndpoint(edge, "to");
        if (from !== rid && to !== rid)
            return false;
        const other = nodeByRid.get(from === rid ? to : from);
        return other?.node_type === "validation";
    });
}
function telemetryGaps(rollups, enabled) {
    if (!enabled) {
        return [
            {
                kind: "telemetry-disabled",
                skill: null,
                failed: 0,
                reason: "Skill telemetry is not enabled, so learning gaps cannot be measured from Skill results",
            },
        ];
    }
    if (rollups.length === 0) {
        return [
            {
                kind: "telemetry-empty",
                skill: null,
                failed: 0,
                reason: "Skill telemetry is enabled but no skill rollups have been recorded",
            },
        ];
    }
    return rollups
        .map((rollup) => ({
        rollup,
        failed: Number(rollup.outcome_counts.failed ?? 0) + Number(rollup.outcome_counts.blocked ?? 0),
    }))
        .filter(({ rollup, failed }) => failed >= 2 && rollup.patch_count === 0 && rollup.change_count === 0)
        .map(({ rollup, failed }) => ({
        kind: "repeated-skill-failures",
        skill: rollup.name,
        failed,
        reason: `${rollup.name} has ${failed} failed/blocked result(s) and no patch/change telemetry`,
    }))
        .sort((a, b) => b.failed - a.failed || String(a.skill).localeCompare(String(b.skill)));
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
function guidanceOrder(a, b) {
    const rank = { "contradicted-guidance": 0, "stale-guidance": 1 };
    return rank[a.kind] - rank[b.kind] || ridOf(a.evidence) - ridOf(b.evidence);
}
function renderLearningDebtReport(report) {
    const lines = [
        "# Memory learning debt",
        "",
        `Status: ${report.status}`,
        "",
        "Summary:",
        `- Repeated failure patterns: ${report.summary.repeatedFailurePatterns}`,
        `- Stale or contradicted guidance: ${report.summary.staleOrContradictedGuidance}`,
        `- Missing validation evidence: ${report.summary.missingValidationEvidence}`,
        `- Skill telemetry gaps: ${report.summary.skillTelemetryGaps}`,
        "",
    ];
    appendSection(lines, "Repeated Failure Patterns", report.categories.repeatedFailurePatterns, (item) => `${item.pattern} (${item.attemptCount} attempts) — lacks durable lesson; evidence ${item.citations.join(", ")}`);
    appendSection(lines, "Stale Or Contradicted Guidance", report.categories.staleOrContradictedGuidance, (item) => `${item.kind}: ${item.evidence} (${item.nodeType}) ${item.title} — ${item.reason}`);
    appendSection(lines, "Missing Validation Evidence", report.categories.missingValidationEvidence, (item) => `${item.evidence} (${item.nodeType}) ${item.title} — ${item.reason}`);
    appendSection(lines, "Skill Telemetry Gaps", report.categories.skillTelemetryGaps, (item) => `${item.kind}: ${item.skill ?? "all skills"} — ${item.reason}`);
    return lines.join("\n").trimEnd() + "\n";
}
function appendSection(lines, title, items, render) {
    lines.push(`## ${title}`);
    if (items.length === 0) {
        lines.push("- none", "");
        return;
    }
    for (const item of items)
        lines.push(`- ${render(item)}`);
    lines.push("");
}
function edgeLabel(edge) {
    return String(edge.label ?? edge.edge_label ?? "");
}
function edgeEndpoint(edge, side) {
    const raw = side === "from"
        ? edge.from ?? edge.from_rid ?? edge.source ?? edge.source_id
        : edge.to ?? edge.to_rid ?? edge.target ?? edge.target_id;
    return Number(raw);
}
function edgeReason(edge) {
    const props = edge.properties;
    return typeof props?.reason === "string" ? props.reason : "";
}
function titleOf(node) {
    return String(node.properties.title ?? node.label);
}
function stringProp(node, key) {
    const value = node.properties[key];
    return typeof value === "string" ? value : "";
}
function numberProp(node, key) {
    const value = Number(node.properties[key]);
    return Number.isFinite(value) ? value : null;
}
function stringArrayProp(node, key) {
    const value = node.properties[key];
    return Array.isArray(value) ? value.map(String) : [];
}
function urn(rid) {
    return `memory_nodes:${rid}`;
}
function ridOf(urnValue) {
    return Number(urnValue.replace(/^memory_nodes:/, ""));
}
