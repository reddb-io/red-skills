---
"@reddb-io/red-skills": patch
---

Every shipped binary answers `--version`, enforced by a repo-wide invariant (#2878). The convergence tickets fixed five binaries one by one; nothing stopped the sixth. Two shipped binaries went without a version surface and nobody noticed until they were tested one at a time, because a binary is added by writing one line in a `bin` map and that line carried no obligation.

**The obligation is now checked from where the binary is DECLARED.** Every `bin` entry in every workspace `package.json` is discovered, resolved to the source that actually runs — a file in the tree, a `dist/` output's `src/` sibling, or, for a packaged shim that forwards its whole argv, the entry of the bundle it execs — and held to two answers. It must print its version off the build stamp (`renderVersion`/`readBuildInfo`), never from config, enablement, a store, or a socket, because `--version` is asked precisely when those are broken; and it must route its arguments through `@reddb-io/shared/args` rather than walking `process.argv` itself. `process.argv` may be read — handed whole to the parser, or sliced past the interpreter and the script — but a binary that walks it with `includes`/`indexOf`/`find` fails, named with the file, the line, and the offending call.

The invariant is declared alongside the repo's other cross-cutting ratchets, so it runs in every gate run including a cone-scoped one, rather than only when someone remembers to ask. Each failure mode is proved by a fixture rather than by asserting the passing state, because a suite that only checks a clean tree cannot tell "clean" from "the check never fires".
