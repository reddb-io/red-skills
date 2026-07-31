---
"@reddb-io/red-skills": patch
---

The local statusline mode resolves its project the way its Workers were labelled. It read only a declared `project.name` from `.red/config.yaml`, while a Worker's label comes from `resolveProjectIdentity` — which falls back to the git remote — so a repository that declares no name reported `project unknown 0w` while the daemon held three Workers stamped `owner/repo`. One fact, one resolver.
