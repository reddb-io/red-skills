# On-Demand Branch Reaper

Run `/afk reap` to perform branch hygiene without claiming an issue. The command prints `afk branch counts: remote-afk=N remote-afk-attempts=N local-afk=N` then applies the same three namespace reapers used at boot. Open issues and transiently unclassified issues are kept; local branches checked out by any worktree are kept.
