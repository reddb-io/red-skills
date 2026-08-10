---
"@reddb-io/dev": patch
---

Stop a stale statusline cache from freezing the terminal prompt. The repo collector awaited its own network refresh when the cache expired — up to five seconds of `gh` on the path that redraws a prompt, measured at eight seconds per render. Stale now serves the previous value with its age stated, and one detached child rewrites both caches for the next render.
