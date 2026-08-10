---
"@reddb-io/redskilled": patch
---

Point every systemd `ExecStart` at a bundle copy nothing on the host prunes. The #3554 fix made unit commands absolute, but an absolute path into the npx cache or a mise toolchain dies the moment those are GC'd or pruned — the same dead unit wearing a longer name. Bundles now stabilize into `~/.red/redskilled/bundles/` (the daemon's own home) whenever their version is certain: the replacement resolver probes the stable home first and files cache hits into it, the supervised boot heal rewrites with the stable copy, and `provision --install-unit` / `unit install` install stable paths. Stabilization is an upgrade, never a precondition — no home, no certain version, or any filesystem refusal keeps the resolved entry untouched, and an env that names no HOME can never reach the real operator's home.
