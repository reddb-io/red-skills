// Single source of truth for the plugins/memory vitest suite split (#242).
//
// The suite is partitioned into two projects so the AFK feedback gate stays
// fast and deterministic:
//
//   - default `test`            → every test NOT listed below. In-process logic
//                                  over the embedded RedDB store. Runs with file
//                                  parallelism + a generous per-test timeout so
//                                  CPU contention cannot trip a correct test.
//   - `test:integration`        → the files listed below. These layer a SECOND
//                                  OS process on top of the implicit RedDB store
//                                  — they bind a real HTTP server, drive a real
//                                  MCP stdio server, shell out to the `memory`
//                                  CLI, or assert a wall-clock latency budget.
//                                  Process/port contention under load makes them
//                                  non-deterministic, so they are excluded from
//                                  the AFK gate and run explicitly / in CI,
//                                  serially (singleFork).
//
// Membership rule (keep deterministic, do not hand-tune individual files):
// a test belongs to INTEGRATION_TESTS iff it spawns a second process — via
// spawnSync/exec*/spawn, createMemoryHttpServer, or an MCP Stdio transport —
// or it asserts a real-time latency/perf budget (recall-latency).
//
// The suite-split.test.ts regression test enforces that this list plus the
// default project partition every tests/*.test.ts file with no overlap and no
// loss of coverage.

export const INTEGRATION_TESTS: readonly string[] = [
  "agent-integration-status.test.ts",
  "architecture-overview-cli.test.ts",
  "ask-cli.test.ts",
  "as-of-recall.test.ts",
  "backup.test.ts",
  "bootstrap-launcher.test.ts",
  "capability-catalog.test.ts",
  "capsule-cli.test.ts",
  "claim-check-cli.test.ts",
  "classify-cli.test.ts",
  "code-drift-cli.test.ts",
  "communities-cli.test.ts",
  "community-digest-cli.test.ts",
  "competitive-baseline.test.ts",
  "competitive-eval-v2.test.ts",
  "competitive-radar.test.ts",
  "context-pack-cli.test.ts",
  "context-status.test.ts",
  "curate-skill.test.ts",
  "doc-search-cli.test.ts",
  "drift-guard-cli.test.ts",
  "evidence-card.test.ts",
  "extraction-status.test.ts",
  "governance.test.ts",
  "governance-tidy-review.test.ts",
  "handoff.test.ts",
  "health.test.ts",
  "hook-coverage.test.ts",
  "hooks-manifest.test.ts",
  "http-server.test.ts",
  "improve-skills.test.ts",
  "inbox-cli.test.ts",
  "ingest-cli.test.ts",
  "init-wizard.test.ts",
  "learning-debt-cli.test.ts",
  "lint-cli.test.ts",
  "mcp-server.core.test.ts",
  "mcp-server.readonly.test.ts",
  "mcp-server.registry.test.ts",
  "mcp-server.session.test.ts",
  "memory-decay.test.ts",
  "memory-merge-pass.test.ts",
  "memory-layers.test.ts",
  "onboarding-map-cli.test.ts",
  "operational-dashboard.test.ts",
  "path-explain.test.ts",
  "path-explain-viewer.test.ts",
  "preflight-cli.test.ts",
  "pre-pr-review-cli.test.ts",
  "privacy-cli.test.ts",
  "project-bootstrap.test.ts",
  "provenance-cli.test.ts",
  "readiness.test.ts",
  "readiness-viewer.test.ts",
  "reasoning-worker.test.ts",
  "recall-latency.test.ts",
  "refresh-cli.test.ts",
  "routing-guide.test.ts",
  "session-cli.test.ts",
  "session-timeline.test.ts",
  "session-timeline-viewer.test.ts",
  "skill-curator.test.ts",
  "skill-events.test.ts",
  "skill-recommendations-cli.test.ts",
  "skill-status.test.ts",
  "smart-search.test.ts",
  "store-recall-roundtrip.test.ts",
  "structural-impact-viewer.test.ts",
  "supersession-cli.test.ts",
  "vcs-commit.test.ts",
  "vcs-hooks-e2e.test.ts",
  "vector-cli.test.ts",
  "vector-status-viewer.test.ts",
  "workbench.test.ts",
  "work-frontier.test.ts",
  "working-memory.test.ts",
];

/** Globs (relative to the plugin root) for the integration project. */
export const integrationGlobs = (): string[] =>
  INTEGRATION_TESTS.map((name) => `tests/${name}`);
