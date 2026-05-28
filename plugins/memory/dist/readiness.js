import { buildCommunityAnalytics } from "./communities.js";
import { buildLearningDebtReport } from "./learning-debt.js";
import { readMemoryEvents } from "./memory-events.js";
import { buildPreflightBrief, } from "./preflight.js";
import { claimCheck } from "./claim-check.js";
import { scanPrivacyRecords } from "./privacy.js";
import { MEMORY_COLLECTION_VERSIONING } from "./vcs-versioned-collections.js";
import { buildSkillRecommendations, } from "./skill-recommendations.js";
import { readSkillRollups } from "./skill-events.js";
const DEFAULT_MIN_EVIDENCE = 2;
const DEFAULT_STALE_DAYS = 90;
export async function buildReadinessEnvelope(store, goal, opts = {}) {
    const now = normalizeNow(opts.now);
    const minEvidence = opts.minEvidence ?? DEFAULT_MIN_EVIDENCE;
    const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
    const preflight = await buildPreflightBrief(store, goal, {
        ...opts,
        now: now.getTime(),
    });
    const [nodes, edges, vector, communities, eventLog, vcs, claim, skillRollups] = await Promise.all([
        store.listNodes(),
        store.listEdges(),
        vectorSummary(store),
        communitySummary(store, now),
        eventLogSummary(store),
        vcsStatus(store),
        claimCheck(store, goal),
        skillRollupSummary(store),
    ]);
    const superseded = await store.supersededByMany(nodes.map((node) => node.rid));
    const [skills, learningDebt] = await Promise.all([
        skillRecommendationSummary(store, goal, skillRollups, opts),
        learningDebtSummary(store, skillRollups, now.getTime(), staleDays),
    ]);
    const trust = trustSummary(nodes, edges, superseded, claim);
    const status = readinessStatus(preflight.status, vector.overall, trust.contradictions.unresolved);
    const evidence = evidenceSummary(preflight, minEvidence);
    const nextActions = nextActionsFor({
        preflight,
        evidence,
        vector,
        contradictions: trust.contradictions.unresolved,
        skills,
        learningDebt,
        communities,
        eventLog,
    });
    return {
        contract: {
            name: "memory.readiness",
            version: "memory.readiness.v1",
            consumer_targets: ["memory-ui", "eval:competitive:v2"],
        },
        request: {
            goal,
            generated_at: now.toISOString(),
            ...(opts.scope ? { scope: opts.scope } : {}),
        },
        status,
        governance: {
            scope: opts.scope ?? { level: "project" },
            include_superseded: true,
            min_evidence: minEvidence,
            stale_days: staleDays,
            ranking_signals: ["scope", "tier", "supersession", "confidence", "freshness"],
        },
        task: { preflight },
        evidence,
        retrieval: {
            recall: {
                evidence_count: preflight.summary.evidenceCount,
                active_evidence_count: preflight.summary.activeEvidenceCount,
                missing_evidence: preflight.summary.missingEvidence,
            },
            vector: {
                overall: vector.overall,
                total: vector.total,
                ready: vector.ready,
                stale: vector.stale,
                unavailable: vector.unavailable,
                failed: vector.failed,
                ...(vector.error ? { error: vector.error } : {}),
            },
        },
        trust,
        vcs,
        operations: {
            event_log: eventLog,
        },
        communities: {
            status: communities.status,
            graph_hash: communities.graph_hash,
            communities: communities.communities.length,
            assignments: communities.assignments.length,
            top: communities.communities.slice(0, 5),
            ...(communities.error ? { error: communities.error } : {}),
        },
        skills,
        learning_debt: learningDebt,
        next_actions: nextActions,
    };
}
function normalizeNow(now) {
    if (now instanceof Date)
        return now;
    if (typeof now === "number")
        return new Date(now);
    return new Date();
}
async function vectorSummary(store) {
    try {
        const vector = await store.vectorStatus();
        return {
            overall: vector.overall,
            total: vector.total,
            ready: vector.ready,
            stale: vector.stale,
            unavailable: vector.unavailable,
            failed: vector.failed,
        };
    }
    catch (err) {
        return {
            overall: "unavailable",
            total: 0,
            ready: 0,
            stale: 0,
            unavailable: 0,
            failed: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function communitySummary(store, now) {
    try {
        return {
            status: "available",
            ...(await buildCommunityAnalytics(store, { cache: "read-only", now })),
        };
    }
    catch (err) {
        return {
            status: "unavailable",
            schema_version: "memory.communities.v1",
            read_only: true,
            graph_hash: "",
            cache_key: "",
            cached: false,
            generated_at: now.toISOString(),
            communities: [],
            assignments: [],
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function skillRollupSummary(store) {
    try {
        return { status: "available", rollups: await readSkillRollups(store) };
    }
    catch (err) {
        return {
            status: "unavailable",
            rollups: [],
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function skillRecommendationSummary(store, goal, rollups, opts) {
    if (rollups.status === "unavailable") {
        return {
            signal_status: "unavailable",
            task: goal,
            status: "insufficient-evidence",
            recommendations: [],
            missingEvidence: ["Skill telemetry rollups are unavailable"],
            error: rollups.error,
        };
    }
    try {
        return {
            signal_status: "available",
            ...(await buildSkillRecommendations(store, goal, {
                limit: opts.limit,
                scope: opts.scope,
                now: opts.now instanceof Date ? opts.now.getTime() : opts.now,
                skillRollups: rollups.rollups,
            })),
        };
    }
    catch (err) {
        return {
            signal_status: "unavailable",
            task: goal,
            status: "insufficient-evidence",
            recommendations: [],
            missingEvidence: ["Skill recommendation evidence is unavailable"],
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function learningDebtSummary(store, rollups, now, staleDays) {
    try {
        const report = await buildLearningDebtReport(store, {
            now,
            staleDays,
            rollups: rollups.rollups,
            skillTelemetryEnabled: rollups.status === "available",
        });
        return {
            status: "available",
            debt_status: report.status,
            summary: report.summary,
            categories: report.categories,
        };
    }
    catch (err) {
        return {
            status: "unavailable",
            debt_status: "unknown",
            summary: null,
            categories: null,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
function evidenceSummary(preflight, minEvidence) {
    const missingMessages = preflight.warnings
        .filter((warning) => warning.kind === "missing-evidence")
        .map((warning) => warning.message);
    return {
        active: preflight.evidence.filter((item) => item.statuses.includes("active")),
        missing: {
            missing: preflight.summary.missingEvidence,
            expected_minimum: minEvidence,
            active_count: preflight.summary.activeEvidenceCount,
            messages: missingMessages,
        },
        contradictions: preflight.warnings.filter((warning) => warning.kind === "contradiction"),
        superseded: preflight.evidence.filter((item) => item.statuses.includes("superseded")),
        stale: preflight.evidence.filter((item) => item.statuses.includes("stale")),
    };
}
function nextActionsFor(input) {
    const actions = [];
    if (input.preflight.summary.missingEvidence) {
        actions.push("Capture or ingest Memory evidence for this task before implementation.");
    }
    if (input.contradictions > 0 || input.evidence.contradictions.length > 0) {
        actions.push("Resolve or supersede contradictory Memory evidence before relying on it.");
    }
    if (input.evidence.superseded.length > 0) {
        actions.push("Prefer active successor memories over superseded evidence.");
    }
    if (input.evidence.stale.length > 0) {
        actions.push("Verify stale Memory evidence before using it as implementation guidance.");
    }
    if (input.vector.overall === "stale" || input.vector.overall === "failed") {
        actions.push("Run `memory vector maintain` to refresh vector retrieval signals.");
    }
    else if (input.vector.overall === "unavailable") {
        actions.push("Treat vector recall as unavailable and rely on text/graph evidence.");
    }
    if (input.skills.recommendations.length > 0) {
        actions.push(`Load recommended skills: ${input.skills.recommendations.map((s) => s.name).join(", ")}.`);
    }
    else {
        actions.push("Proceed without ranked Skill recommendations; no matching Skill evidence was available.");
    }
    if (input.learningDebt.status === "available" && input.learningDebt.debt_status === "debt-found") {
        actions.push("Review Memory learning debt before starting implementation.");
    }
    else if (input.learningDebt.status === "unavailable") {
        actions.push("Treat learning debt signals as unavailable for this task.");
    }
    if (input.communities.status === "unavailable") {
        actions.push("Treat community analytics as unavailable for this task.");
    }
    if (input.eventLog.status === "unavailable") {
        actions.push("Treat Memory event-log telemetry as unavailable for this task.");
    }
    if (actions.length === 0)
        actions.push("Memory readiness is clean; proceed with implementation.");
    return [...new Set(actions)];
}
function readinessStatus(preflight, vector, unresolvedContradictions) {
    if (preflight === "needs-evidence")
        return "needs-evidence";
    if (preflight === "review-warnings" || vector === "failed" || unresolvedContradictions > 0) {
        return "review-warnings";
    }
    return "ready";
}
function trustSummary(nodes, edges, superseded, claim) {
    const provenance = provenanceSummary(nodes);
    const contradictions = contradictionSummary(edges, superseded);
    const privacy = scanPrivacyRecords([
        ...nodes.map(nodePrivacyRecord),
        ...edges.map(edgePrivacyRecord),
    ]);
    return {
        provenance,
        supersession: {
            superseded_nodes: superseded.size,
            active_successors: new Set(superseded.values()).size,
        },
        contradictions,
        privacy: {
            read_only: true,
            total_memories: nodes.length + edges.length,
            findings: privacy.length,
            warnings: privacy.filter((finding) => finding.severity === "warning").length,
            errors: privacy.filter((finding) => finding.severity === "error").length,
        },
        claim_check: {
            assertion: claim.assertion,
            status: claim.status,
            active_evidence: claim.evidence.active.length,
            superseded_evidence: claim.evidence.superseded.length,
            conflicts: claim.evidence.conflicting.length,
        },
    };
}
function provenanceSummary(nodes) {
    const sourceKinds = {};
    let withProvenance = 0;
    let evidenceRefs = 0;
    for (const node of nodes) {
        const provenance = node.properties.provenance;
        if (!isProvenance(provenance))
            continue;
        withProvenance += 1;
        sourceKinds[provenance.source_kind] = (sourceKinds[provenance.source_kind] ?? 0) + 1;
        evidenceRefs += provenance.evidence?.length ?? 0;
    }
    return {
        total_nodes: nodes.length,
        nodes_with_provenance: withProvenance,
        missing_provenance: nodes.length - withProvenance,
        source_kinds: sourceKinds,
        evidence_refs: evidenceRefs,
    };
}
function isProvenance(value) {
    return (value != null &&
        typeof value === "object" &&
        typeof value.source_kind === "string");
}
function contradictionSummary(edges, superseded) {
    const seenPairs = new Set();
    const contradictions = edges.filter((edge) => {
        if (edgeLabel(edge) !== "CONTRADICTS")
            return false;
        const from = edgeEndpoint(edge, "from");
        const to = edgeEndpoint(edge, "to");
        const key = from < to ? `${from}:${to}` : `${to}:${from}`;
        if (seenPairs.has(key))
            return false;
        seenPairs.add(key);
        return true;
    });
    const unresolved = contradictions.filter((edge) => {
        const from = activeHead(edgeEndpoint(edge, "from"), superseded);
        const to = activeHead(edgeEndpoint(edge, "to"), superseded);
        return Number.isFinite(from) && Number.isFinite(to) && from !== to;
    });
    const unresolvedPairs = unresolved.map((edge) => {
        const props = edgeProperties(edge);
        const fromSession = typeof props.candidate_session === "string" ? props.candidate_session : null;
        const toSession = typeof props.existing_session === "string" ? props.existing_session : null;
        return {
            from_rid: edgeEndpoint(edge, "from"),
            to_rid: edgeEndpoint(edge, "to"),
            kind: typeof props.kind === "string" ? props.kind : null,
            reason: typeof props.reason === "string" ? props.reason : null,
            from_session: fromSession,
            to_session: toSession,
        };
    });
    const crossSession = unresolvedPairs.filter((pair) => pair.from_session && pair.to_session && pair.from_session !== pair.to_session).length;
    return {
        total: contradictions.length,
        unresolved: unresolved.length,
        cross_session: crossSession,
        unresolved_pairs: unresolvedPairs,
    };
}
async function eventLogSummary(store) {
    try {
        const events = await readMemoryEvents(store);
        const kinds = {};
        for (const event of events)
            kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
        return {
            status: "available",
            total_events: events.length,
            kinds,
            recent: [...events]
                .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at))
                .slice(0, 5)
                .map((event) => ({
                id: event.id,
                occurred_at: event.occurred_at,
                kind: event.kind,
                subject: event.subject.id ?? event.subject.name ?? null,
            })),
        };
    }
    catch (err) {
        return {
            status: "unavailable",
            total_events: 0,
            kinds: {},
            recent: [],
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
async function vcsStatus(store) {
    const collections = await Promise.all(MEMORY_COLLECTION_VERSIONING.map(async (collection) => {
        const expected = shouldVersion(collection.tiers)
            ? "versioned"
            : "non-versioned";
        const status = await collectionVersionStatus(store, collection.name, expected);
        return { name: collection.name, expected, ...status };
    }));
    const required = collections.filter((collection) => collection.expected === "versioned");
    const versioned = required.filter((collection) => collection.status === "versioned").length;
    return {
        time_travel: versioned === required.length
            ? "available"
            : versioned > 0
                ? "partial"
                : "unavailable",
        collections,
    };
}
async function collectionVersionStatus(store, collection, expected) {
    try {
        await store.raw.query(`SELECT * FROM ${collection} AS OF SNAPSHOT 0`);
        return { status: expected === "versioned" ? "versioned" : "unexpected-versioned" };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("AS OF requires a versioned collection")) {
            return { status: "non-versioned" };
        }
        return { status: "unavailable", error: message };
    }
}
function shouldVersion(tiers) {
    return tiers.some((tier) => tier === "durable" || tier === "reasoning");
}
function nodePrivacyRecord(node) {
    return {
        id: `memory_nodes:${node.rid}`,
        location: `memory_nodes:${node.rid}`,
        fields: {
            label: node.label,
            node_type: node.node_type,
            properties: node.properties,
        },
    };
}
function edgePrivacyRecord(edge) {
    const rid = Number(edge.rid ?? edge.red_entity_id ?? edge.RED_ENTITY_ID ?? 0);
    return {
        id: `memory_edges:${Number.isFinite(rid) && rid > 0 ? rid : "unknown"}`,
        location: `memory_edges:${Number.isFinite(rid) && rid > 0 ? rid : "unknown"}`,
        fields: {
            label: edgeLabel(edge),
            properties: edgeProperties(edge),
        },
    };
}
function edgeLabel(edge) {
    return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}
function edgeEndpoint(edge, side) {
    if (side === "from") {
        return Number(edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id ?? edge.FROM);
    }
    return Number(edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id ?? edge.TO);
}
function edgeProperties(edge) {
    const props = edge.properties ?? edge.PROPERTIES;
    return props && typeof props === "object" ? props : {};
}
function activeHead(rid, superseded) {
    const seen = new Set();
    let current = rid;
    while (!seen.has(current)) {
        seen.add(current);
        const next = superseded.get(current);
        if (next == null)
            return current;
        current = next;
    }
    return current;
}
