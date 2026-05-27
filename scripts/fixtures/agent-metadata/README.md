# Agent metadata fixtures

Used by `scripts/test-validate-agent-metadata.sh` to exercise
`scripts/validate-agent-metadata.sh`. Each directory under `valid/` is
expected to pass validation; each under `invalid/` is expected to fail with
a specific error.

Layout mirrors a real plugin tree (`agents/`, `.codex-plugin/`) so the
validator runs against the fixture without modification.
