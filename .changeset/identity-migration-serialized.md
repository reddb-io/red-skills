---
"@reddb-io/redskilled": patch
---

The identity migration is serialized and re-keys the session journal through the live journal instance. Two live defects: the boot pass and a first bind's remember ran the same alias concurrently (two rm/rename races over the same directories, two persists of the same control map — the shape of the 2026-08-25 project-control wedge), and the journal re-key rewrote the FILE, which the durable journal's own next append silently undid (observed as "re-keyed 110 sessions" repeating on every boot).
