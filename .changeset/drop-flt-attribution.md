---
"@reddb-io/red-skills": patch
---

Statusline drops the per-worker fleet-attribution tokens (#2568): no more `flt=unattributed` / `flt=<name>` in worker lines — maintainer-confirmed display noise. Fleet ownership stays available in `fleet_status`/`worker_status`; the fleet chip header is unchanged.
