---
"@reddb-io/red-skills": patch
---

Every workspace now rides one product version train. The `ignore` array in `.changeset/config.json` held eight packages — `redskilled`, the VS Code extension, `rsp`, `afk-container`, `red-castle`, `red-browser`, `cdp-driver` and `browser-bridge` — and the herdr plugin was in neither `ignore` nor `fixed`, so it drifted on its own. The daemon sat at `0.1.0` and the VS Code extension at `0.1.0` through every release of a product numbered 3.3.x, which is what the marketplace showed an operator. The array is now empty and the fixed group holds nineteen packages, so a release moves them together; `scripts/sync-version.mjs` gains the surfaces outside the pnpm workspace that carry the same number, and `pnpm version:sync:check` fails when any of them drifts. A version stated in three places that disagree is three versions, and the check is the part that keeps the number honest rather than the number itself.
