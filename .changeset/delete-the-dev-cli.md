---
"@reddb-io/red-skills": major
---

`red-skills-dev` is deleted: one binary owns the execution chain

ADR 0147 §1 makes `redskilled` the only shipped binary of the execution chain.
This removes the dev CLI bundle, its 36-command router, the `run` body with its
supervisor and project-side launch template, the `afk.mjs` forwarder, the
entrypoint's `run` role and the `red-skills-dev` bin — about 28,000 lines.

Every workflow verb a skill still names now reaches an `rs_*` MCP tool; the
surfaces only the router could reach (retake, the MCP worker-birth adapter, the
codex monitor agent, mcp-first suggestions) leave with it, and their suites with
them. The extinct-execution-chain, shipped-binary, host-owns-birth, engine-floor
and declared-wait inventories all shrink to what remains — the baselines only
ever go down.
