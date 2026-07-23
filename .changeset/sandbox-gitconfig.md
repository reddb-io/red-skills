---
"@reddb-io/red-skills": patch
---

Sandboxes stop writing the HOST global gitconfig (#2494): safe.directory and identity setup are skipped for the `none` provider (same-UID worktree, and the shared-file lock races across concurrent workers) and kept for container providers; a setup-phase `could not lock config file` failure is classified infra-transient, never a no-sentinel death
