---
"@reddb-io/red-skills": patch
---

The per-project producer now re-checks the published version and hands over to a newer bundle instead of stranding on the one it resolved at launch (#2925). It resolved a bundle once, at boot, from the local ladder, and never asked again — so `project_start` went on reporting `bundle_version: 3.0.3` while npm already served 3.0.4, every Worker born after the release boot-halted on skew, and the producer kept ticking and reporting itself healthy. Over one session that stranded a dispatch twice and left four `ready-for-agent` issues unworked with free slots available.

**The component that decides when Workers are born must not strand.** The daemon already answered this for itself — it probes every 15 minutes and comes back on the new bundle — and the producer now asks the same question on the same cadence (`RED_AFK_REPLACE_CHECK_MS`; `0` turns it off), under the same four rules. A replacement is a restart, not an evacuation: the live Workers are the daemon's units, so the successor adopts them by pid and nothing is stopped, drained or re-queued. The version reported is always the version RUNNING — the published answer is carried beside it, never folded into it (#2809). A local build replaces itself with nothing. And a major boundary is never crossed on a background timer.

The successor is **pinned** to the version that was decided, not resolved afresh — an entry that landed on any other version would let the skew survive the very restart it exists to end — and it is prepared before anything is given up: a published version this host can run from nowhere is not an adoptable answer, so the producer keeps working rather than releasing its identity to a successor that cannot start.
