const NOW = 1_700_000_000_000;
function node(rid, node_type, title, content, tags) {
    return {
        rid,
        label: title.toLowerCase().replace(/\W+/g, "-"),
        node_type,
        properties: {
            title,
            content,
            tags,
            confidence: "EXTRACTED",
            source: "competitive-fixture",
            importance: 0.9,
            tier: "durable",
            scope: "project",
            created_at: NOW,
            updated_at: NOW,
        },
    };
}
export const competitiveEvalFixture = {
    name: "memory-moat-claims",
    source: "checked-in",
    nodes: [
        node(1, "concept", "Release gate policy", "Project rule: Memory README moat claims must be backed by executable eval output. Before changing comparison copy, run pnpm test, typecheck, and the competitive eval command, then cite the measured harness result instead of unsupported copy.", ["release", "readme", "claims"]),
        node(2, "decision", "Context pack budget decision", "Decision: context packs should compile recalled graph evidence into cited, budgeted Markdown. They are useful when the packed context is materially smaller than the naive full-memory prompt while keeping the relevant constraints and prior decisions.", ["context-pack", "budget", "reduction"]),
        node(3, "problem", "Policy lint storage pitfall", "Pitfall: durable Memory should not store current progress updates, raw task logs, imperative instructions, or credential placeholders. Candidate memories should be classified before persistence and lint should flag policy violations.", ["policy", "lint", "credential", "progress"]),
        node(4, "workflow", "Do not claim live competitor wins", "Do not claim apples-to-apples wins against service-backed competitors unless the live baseline is configured and measured. Mark those comparisons as unmeasured when the harness only has checked-in local fixtures.", ["competitor", "live-baseline", "claims"]),
        node(5, "concept", "Graphify fixture baseline", "The checked graphify-out baseline records 551 nodes, 1329 edges, 34 communities, 491 inferred edges, and an 841 ms path p50. Claims against graphify in this repo must stay tied to this checked fixture.", ["graphify", "latency", "fixture"]),
        node(6, "concept", "Agent-memory live baseline gap", "Apples-to-apples recall latency or extraction-quality claims against neo4j-labs agent-memory require a live Neo4j baseline. Without that configured live service, the README may only mark the comparison as unmeasured or conceded.", ["agent-memory", "neo4j", "live-baseline"]),
    ],
    edges: [
        { from: 1, to: 2, label: "REFERENCES" },
        { from: 2, to: 3, label: "REFERENCES" },
        { from: 4, to: 6, label: "REFERENCES" },
        { from: 5, to: 1, label: "REFERENCES" },
    ],
    recall: [
        {
            id: "readme-claims-release-gate",
            query: "release memory README claims",
            expectedRids: [1],
            k: 3,
        },
        {
            id: "live-competitor-latency",
            query: "live Neo4j competitor latency claim",
            expectedRids: [4, 6],
            k: 4,
        },
        {
            id: "policy-credential-progress",
            query: "policy credential progress memory",
            expectedRids: [3],
            k: 3,
        },
    ],
    contextPacks: [
        {
            id: "readme-moat-update",
            goal: "Update README with measured memory moat claims",
            budgetChars: 950,
        },
    ],
    candidates: [
        {
            id: "stable-project-rule",
            text: "Project rule: competitive README rows must cite the eval harness output.",
            expectedKind: "store",
            expectedTier: "durable",
            expectedScope: "project",
            expectedWarnings: [],
        },
        {
            id: "temporary-progress",
            text: "Current progress: tests are running for the eval harness implementation.",
            expectedKind: "ephemeral",
            expectedTier: "ephemeral",
            expectedScope: "session",
            expectedWarnings: [],
        },
        {
            id: "secret-like-token",
            text: "api_key = sk_fixture_1234567890abcdef1234567890",
            expectedKind: "redact",
            expectedTier: "ephemeral",
            expectedScope: "session",
            expectedWarnings: ["likely-secret"],
        },
        {
            id: "decision-rationale",
            text: "Decision rationale: use checked fixtures because live competitors require external services.",
            expectedKind: "reasoning",
            expectedTier: "reasoning",
            expectedScope: "project",
            expectedWarnings: [],
        },
        {
            id: "branch-specific",
            text: "On branch eval-harness, the fixture names are temporary until the PR lands.",
            expectedKind: "scope-narrowly",
            expectedTier: "durable",
            expectedScope: "branch",
            expectedWarnings: [],
        },
    ],
    policyMemories: [
        {
            id: "lint-good",
            title: "Stable eval rule",
            body: "Project rule: checked fixtures back competitive comparison claims.",
            scope: "project",
            tier: "durable",
            createdAt: NOW,
        },
        {
            id: "lint-progress",
            title: "Current progress update",
            body: "Current progress: tests are running and the eval harness is halfway complete.",
            createdAt: NOW - 30 * 86_400_000,
        },
        {
            id: "lint-secret",
            title: "Remember to inspect credentials",
            body: "Remember to always inspect api_key: REDACTED before storing memory.",
            scope: "project",
            tier: "durable",
            createdAt: NOW,
        },
    ],
    liveBaselines: [
        {
            competitor: "agent-memory",
            metric: "recall latency",
            configured: false,
            assertedClaim: false,
        },
    ],
    publicClaims: [
        {
            id: "checked-fixture-retrieval",
            text: "The competitive eval reports retrieval quality from checked-in fixtures.",
            requiredEvidence: ["dimension:retrieval", "fixture:recall"],
        },
        {
            id: "readiness-envelope-consumer",
            text: "The readiness envelope is available for eval:competitive:v2 consumers.",
            requiredEvidence: ["dimension:readiness", "foundation:readiness-envelope"],
        },
        {
            id: "session-lifecycle-comparison",
            text: "Memory has native agent session lifecycle integration in the comparison table.",
            requiredEvidence: ["baseline:memory-lifecycle-beats-agent-memory"],
        },
        {
            id: "operator-surface-dashboard",
            text: "The competitive eval measures docs, hooks, dashboard, and capability catalog operator surfaces.",
            requiredEvidence: [
                "dimension:operator-surface",
                "foundation:doc-coverage",
                "foundation:hook-coverage",
                "foundation:operational-dashboard",
                "foundation:capability-catalog",
            ],
        },
        {
            id: "multi-agent-integration-status",
            text: "The competitive eval measures multi-agent Memory routing and integration status across supported coding agents.",
            requiredEvidence: [
                "dimension:multi-agent-integration",
                "foundation:routing-guide",
                "foundation:agent-integration-status",
                "foundation:mcp-agent-tools",
                "foundation:hook-backed-agent-integration",
            ],
        },
        {
            id: "intelligent-memory-five-surfaces",
            text: "Memory is intelligent: composed confidence, reasoning-replay, federation, what-if, and autocure each ship as a measured surface (#173).",
            requiredEvidence: [
                "dimension:intelligence",
                "foundation:confidence-scoring",
                "foundation:reasoning-replay",
                "foundation:federation",
                "foundation:whatif",
                "foundation:autocure",
            ],
        },
    ],
};
export const competitiveInteropFixtures = [
    {
        competitor: "graphify-like",
        artifactName: "graphify-static-code-graph",
        source: "checked-in",
        nodes: [
            { id: "file:src/auth.ts", kind: "file", label: "src/auth.ts" },
            { id: "symbol:authenticateUser", kind: "function", label: "authenticateUser" },
            { id: "symbol:SessionStore", kind: "class", label: "SessionStore" },
            { id: "community:auth-flow", kind: "community", label: "auth-flow" },
        ],
        edges: [
            { from: "file:src/auth.ts", to: "symbol:authenticateUser", kind: "DEFINES" },
            { from: "file:src/auth.ts", to: "symbol:SessionStore", kind: "DEFINES" },
            { from: "symbol:authenticateUser", to: "symbol:SessionStore", kind: "CALLS" },
            { from: "community:auth-flow", to: "symbol:authenticateUser", kind: "GROUPS" },
        ],
        mapping: [
            {
                sourceConcept: "file and symbol identity",
                memoryConcept: "source-backed Memory nodes",
                decision: "preserved",
                count: 2,
                rationale: "Stable labels and source paths can be retained as node properties and provenance evidence.",
            },
            {
                sourceConcept: "code relationship kinds",
                memoryConcept: "typed Memory edges with relationship labels in properties",
                decision: "approximated",
                count: 2,
                rationale: "Memory can keep the endpoints and a relationship label, but it does not expose Graphify's full static-code edge taxonomy.",
            },
            {
                sourceConcept: "layout, ranking, and path timing metadata",
                memoryConcept: null,
                decision: "dropped",
                count: 2,
                rationale: "The interop report is a shape-mapping fixture, not a Graphify renderer or benchmark replay.",
            },
        ],
        caveats: [
            "This fixture maps a Graphify-like static graph shape; it does not claim full Graphify import, rendering, or query parity.",
        ],
    },
    {
        competitor: "neo4j-agent-memory-like",
        artifactName: "neo4j-agent-memory-session-export",
        source: "checked-in",
        nodes: [
            { id: "episode:session-1", kind: "Episode", label: "session-1" },
            { id: "memory:release-gate", kind: "Memory", label: "Release gate policy" },
            { id: "entity:Memory", kind: "Entity", label: "Memory" },
            { id: "observation:claim-guard", kind: "Observation", label: "claim guard" },
            { id: "index:semantic", kind: "VectorIndex", label: "semantic index" },
        ],
        edges: [
            { from: "episode:session-1", to: "memory:release-gate", kind: "RECORDED" },
            { from: "memory:release-gate", to: "entity:Memory", kind: "MENTIONS" },
            { from: "memory:release-gate", to: "observation:claim-guard", kind: "SUPPORTS" },
            { from: "index:semantic", to: "memory:release-gate", kind: "INDEXES" },
        ],
        mapping: [
            {
                sourceConcept: "memory text, entity labels, and provenance",
                memoryConcept: "Memory node properties and provenance evidence",
                decision: "preserved",
                count: 3,
                rationale: "Durable facts, entity names, and source/session evidence fit directly into Memory records.",
            },
            {
                sourceConcept: "Neo4j labels, relationship names, and episodic grouping",
                memoryConcept: "Memory node types, edge labels, and scope metadata",
                decision: "approximated",
                count: 3,
                rationale: "Memory can retain the semantic intent, but not every Neo4j label, relationship, or traversal convention has a one-to-one Memory concept.",
            },
            {
                sourceConcept: "Cypher/index configuration and geospatial database features",
                memoryConcept: null,
                decision: "dropped",
                count: 2,
                rationale: "Checked fixtures do not stand up Neo4j, replay indexes, or assert database-engine feature parity.",
            },
        ],
        caveats: [
            "This fixture maps a Neo4j-agent-memory-like export shape; it does not claim full Neo4j, Cypher, geospatial, or live-service parity.",
        ],
    },
];
