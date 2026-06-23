# Memory ships governed write surface before completing the moat foundation

## Status

accepted.

## Context

ADR 0023 put the Memory moat foundation ahead of surface expansion: vector/hybrid recall, VCS/time-travel memory, operational telemetry, and graph analytics were meant to become real before demos, broad MCP/API expansion, or competitive benchmarks drove the roadmap.

Headroom changed the competitive pressure. Its memory story is easier to demonstrate because agents can save and search cross-agent memory quickly, while its `learn` flow turns failures into agent instructions. RedSkills Memory still wins on governed operational evidence, provenance, validation awareness, and review gates, but that advantage is not visible enough without a write-capable cross-agent path.

## Decision

Memory amends ADR 0023 for the next delivery cycle: ship a governed write MCP surface and cross-agent smoke test before completing the full moat foundation.

The first write surface is `memory_store_evidence`, not a raw `memory_save` clone. It is exposed through MCP for cross-agent interop plus a CLI companion for deterministic tests and operator inspection; both adapters call the same shared write policy and execution function. The caller provides claim, source reference, citation excerpt, intent, and observer identity; a deterministic server-side policy returns a **Governed write result** with `stored`, `proposed`, or `rejected`. Only source-cited, low-blast-radius validation **Operational evidence** may be stored directly through **Low-risk autopromotion**, and direct `stored` writes require graph mode in the first slice. Medium- or high-blast-radius writes become **Evidence cards** or proposals.

The first smoke test is deliberately narrow: one agent stores validation evidence, another agent recalls it with provenance, and the result shows the policy decision. CI may run this as a deterministic runner-labeled test, while docs and manual validation show real cross-agent interop against the same graph store. This keeps the demo crisp without relaxing Memory's governance model.

If graph mode is unavailable, `memory_store_evidence` returns `rejected` with an infrastructure reason such as `graph_mode_required`. It does not fall back to markdown-only mode or create an Evidence card for storage unavailability.

## Consequences

The foundation from ADR 0023 remains the moat, but it no longer blocks the first user-visible write/cross-agent proof. Benchmarks and Workbench copy should show "mistakes avoided" and governed provenance, not only recall or token savings. Future write tools must justify any expansion against this ADR's server-owned policy and review-gated mutation boundary.
