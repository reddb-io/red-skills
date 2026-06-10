# Validation Sidecar

During feedback validation, AFK writes `.red/tmp/workers/{id}/{N}-a{n}/validation.jsonl` — not rendered into the issue comment, but consumed by the optional Memory bridge:

```json
{"schema":"red.afk.validation.v1","name":"test:plugins/memory","command":"pnpm -C /repo/plugins/memory test","status":"passed","durationMs":1234,"summary":"command exited 0"}
```

Fields: `schema`, `name` (stable check name like `test:root` or `typecheck:plugins/memory`), `command` (when run; omitted for skipped), `status` (`passed`, `failed`, `skipped`), `durationMs` (when run), `summary`.
