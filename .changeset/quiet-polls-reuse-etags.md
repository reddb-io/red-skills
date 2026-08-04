---
"@reddb-io/redskilled": patch
---

Poll repository activity and queue discovery through conditional Octokit REST reads, preserving the last answer on `304 Not Modified` while keeping quota and network failures distinct.
