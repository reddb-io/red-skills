# Memory moat foundation before surface expansion

## Context

The Memory plugin competes with several adjacent products:

- `rohitg00/agentmemory`, the closest direct competitor for operational memory
  for coding agents.
- `neo4j-labs/agent-memory`, a broader agent-memory SDK/platform backed by
  Neo4j/NAMS.
- `graphify` and `Understand-Anything`, which are stronger in codebase graph,
  visual onboarding, and polished product surfaces.

The Memory plugin already has strong operational-memory primitives: graph mode,
agent lifecycle hooks, governed recall, provenance, claim-checking, privacy,
supersession, context packs, skill telemetry, learning proposals, and reasoning
attempt records.

The strategic risk is surface-area competition. Competitors have viewer/replay
UX, broad MCP/REST surfaces, public benchmark narratives, framework
integrations, and polished demos. Copying those surfaces first would improve
perception, but it would not make the Memory product harder to copy.

## Decision

The next Memory cycle prioritizes the **Memory moat foundation** before surface
expansion.

The foundation consists of four RedDB-backed substrate capabilities:

1. **Vector/hybrid recall** — RedDB-native vector retrieval acts as an
   additional seed provider for governed Memory recall.
2. **VCS/time-travel memory** — AS OF recall answers what Memory knew at a
   historical RedDB VCS reference.
3. **Operational telemetry** — a Memory event log captures skill, attempt,
   validation, hook, and lifecycle observations as a shared telemetry substrate.
4. **Graph analytics/community** — RedDB graph analytics, starting with
   community assignments, become first-class Memory evidence.

UI, MCP/API expansion, and competitive benchmarking remain important, but they
should consume the real foundation rather than drive placeholder
implementations. A shared Memory readiness envelope will later connect the
foundation to UI and `eval:competitive:v2`.

## Alternatives considered

- **Surface-first roadmap.** Build viewer, replay, broad MCP tools, and
  public benchmarks first. Rejected because it risks producing a polished shell
  over the existing substrate while competitors retain similar or broader
  surfaces.
- **Benchmark-first roadmap.** Use `eval:competitive:v2` as the coordinating
  artifact before implementing deeper RedDB capabilities. Rejected because the
  benchmark should measure RedDB-native advantages, not define them in fixtures.
- **Demo-first roadmap.** Create a separate demo corpus. Rejected because the
  current RedSkills repository is the product evidence base: ADRs, contexts,
  PRDs, code, tests, issues, and Memory graph evidence already form the proof
  surface.
- **One moat at a time to completion.** Rejected because Memory's competitive
  thesis depends on RedDB as a multi-model substrate; a single deep moat would
  leave the product exposed on the other axes.

## Consequences

- Foundation work must prove three things before being treated as complete:
  internal API, real RedDB round-trip tests, and operation against the current
  RedSkills repository evidence base.
- Vector/hybrid recall is first because it directly addresses the most visible
  retrieval claim from `agentmemory`.
- VCS/time-travel memory is second, with AS OF recall as the first visible
  capability.
- UI and benchmark contracts should be designed early, but implementation
  priority stays with RedDB-backed substrate work until the foundation is real.
- Public positioning should emphasize governed operational memory and RedDB
  substrate depth, not raw endpoint count or demo polish.
