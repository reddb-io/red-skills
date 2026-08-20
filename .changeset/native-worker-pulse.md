---
"@reddb-io/redskilled": patch
---

A native Worker's turn events are stamped as its statusline pulse: the demand
turn records the work item at admission and each session update as it arrives,
into the same maps the heartbeat op feeds, and the statusline payload derives
`hb=<age of the last pulse>` when the display published none — so a live
Worker no longer reads `hb=?` while it streams.
