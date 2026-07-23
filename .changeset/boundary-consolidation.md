---
"@reddb-io/red-skills": minor
---

Boundary consolidation (ADR 0123): red-castle prunes to RedSkills' development shape (vercel/daytona sandboxes and cursor/copilot/devin agent providers removed as a recorded permanent upstream divergence; pi kept whole); the claim engine gains a single owner in `engine/tracker/claim.ts` with the proven #2385-hardened implementation absorbed from apps/dev, dev-side re-export shims, and a two-sided pinned wire fixture; the castle MCP adapter's capture-and-reparse tools (`retake`, `triage`, `respond`, `daily_review`, `weekly_review`, `worker_stop`/`worker_recycle`) now call value-returning cores with a guard test; `mcp-server` is published through the package exports map; `/hitl`, `/triage`, `/retake`, `/dashboard`, and `/daily-review` become MCP-first castle clients bound by the doc-contract test; and apps/dev drops its tested-but-unwired dead modules.
