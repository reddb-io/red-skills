---
"@reddb-io/worker": patch
"@reddb-io/shared": patch
---
Fix: Worker terminal no longer inherits the machine's ambient GitHub credentials via the gh keyring or git credential helper. The credential-free environment now replaces HOME with a temp directory so that even if a command bypasses the terminal policy, it finds no token to use.
