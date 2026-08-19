---
"@reddb-io/red-skills": patch
---

A launch template can name the work item its Worker was born for

The poll keeps identifiers (#4098); the launch is where one reaches a Worker.
`{{work_item}}` joins `{{worker_id}}`, `{{slot}}`, `{{workspace_path}}` and
`{{log_path}}` as a fact a birth supplies, and the planner hands each birth one
identifier — never the same one twice in a tick, and skipping as many as the
project already has Workers, because the planner cannot see which item a live
Worker claimed but can at least decline to create a collision on purpose.

**Deliberately not the log path's rule.** A blank log path is a Worker that says
nothing; a blank work item is a Worker that would claim whatever it found, or
nothing at all. So a template that names `{{work_item}}` while the birth has
none fails closed, naming the missing fact.

Second slice of Spec #4097.
