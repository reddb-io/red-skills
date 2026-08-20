---
"@reddb-io/worker": patch
---

The publish-as ref is anchored in the Worktree before the publish request
goes out: the daemon delivers by fetching `refs/heads/<branch>` from the
Worktree, and a name that existed only as a request field fetched nothing
("couldn't find remote ref refs/heads/red/<worker>/<ticket>").
