# benchmark-code-understanding

Internal A/B harness for measuring RedSkills code understanding against
CodeGraph and a no-MCP baseline.

The default corpus is the language overlap where `code-nav` already has a
default LSP adapter: TypeScript, Python, Go, and Rust. Real runs are opt-in
because they clone external repositories and invoke a headless agent.

```bash
pnpm --filter @reddb-io/benchmark-code-understanding dev doctor
pnpm --filter @reddb-io/benchmark-code-understanding dev run --dry-run
pnpm --filter @reddb-io/benchmark-code-understanding dev run --runs 1
pnpm --filter @reddb-io/benchmark-code-understanding dev report --input .red/tmp/bench/code-understanding/runs.toonl --human
```

By default, generated benchmark data lives under `.red/tmp/bench/` so it stays
out of git with the rest of local tmp state.

Arms:

- `none`: empty MCP config.
- `redskills`: local `code-nav` MCP bundle.
- `codegraph`: `npx @colbymchenry/codegraph` MCP server after `codegraph init -i`.

The report includes aggregate metrics plus explicit `redskills_vs_none` and
`redskills_vs_codegraph` comparisons. Token/cost/read-reduction claims are
reported as claim guards; use `--fail-on-unsupported-claims` only in CI gates
that intentionally require those claims to hold.
