// core/statusline-bedrock-style — the themed render of the Statusline Bedrock.
//
// **The paint moved DOWN to `@reddb-io/redskilled-render`**, beside the render
// of the tail it sits next to: the `redskilled` bundle draws both halves of the
// line now (ADR 0147 deleted the dev bundle, PR #4272 flipped the producer), and
// the daemon may not import a runtime (dependency-direction guard #4135).
//
// This module is the seam this app's own consumers and tests already import.

export {
  paintLifecycleTokens,
  renderStatuslineBedrockThemed,
} from "@reddb-io/redskilled-render/bedrock-style.js";
