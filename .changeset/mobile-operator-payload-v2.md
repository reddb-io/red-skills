---
"@reddb-io/protocol-acp": minor
"@reddb-io/redskilled": minor
"@reddb-io/red-skills-link-protocol": minor
---

Mobile operator state answer v2 (additive): a `host` block (daemon_version, started_at, worker_ceiling, honest staleness mirrored from the statusline read, generated_at) and per-Worker `phase`, `heartbeat_age_ms`, `repository`, `ticket` — sourced from the one statusline document, never a second read; deliberately no vitals and no log lines (ADR 0166).
