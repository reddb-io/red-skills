---
"@reddb-io/dev": minor
"@reddb-io/redskilled": minor
---

Re-theme the statusline under the bedrock/tail split (PR #3599). The shared render palette now derives every tone from published brand tokens (ADR 0137): the project block is the brand field (`brand.primary` ground, `brand.on-primary` ink), the model block recedes to `neutral.900`/paper, the lifecycle bar is a neutral intensity ramp, and `red.500` is the one failure spotlight — the pre-brand hand-tuned wine palette is deleted and the truecolor extinction ratchet now sweeps the render package. The Statusline Bedrock gains a themed render (brand field + kv hierarchy) pinned to be the plain render byte for byte behind the paint, the lifecycle tokens (`rsk=`, `age=`) paint in the same kv convention, and `NO_COLOR` restores the plain line end to end, stripping the daemon tail at the adapter boundary.
