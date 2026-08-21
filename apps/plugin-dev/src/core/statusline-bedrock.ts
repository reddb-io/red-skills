// core/statusline-bedrock — the Statusline Bedrock segment (ADR 0141 §1).
//
// **The render moved DOWN to `@reddb-io/shared`.** ADR 0147 deleted the dev
// bundle that used to draw this half, and PR #4272 pointed the host's statusline
// at the `redskilled` bundle — which renders only the tail, so the operator lost
// model, branch and context from their bar. The daemon may not import a runtime
// (dependency-direction guard #4135: daemon rank 4, runtime rank 5), so the
// bedrock now lives at rank 1 where both halves' producer can reach it.
//
// This module is the seam this app's own consumers already import.

export type {
  ClaudeInput,
  LocalDiffInput,
  ProjectInput,
  StatuslineBedrockInput,
} from "@reddb-io/shared/statusline-bedrock.js";
export {
  composeStatuslineLines,
  renderBedrockProjectBlock,
  renderLocalDiffBlock,
  renderStatuslineBedrock,
} from "@reddb-io/shared/statusline-bedrock.js";
