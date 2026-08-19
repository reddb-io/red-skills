// Wire-format compatibility guard for the claim shim (boundary consolidation).
//
// The claim engine lives in red-castle (`engine/tracker/claim.ts`); dev reaches
// it through the `core/claim.ts` re-export shim. This test imports the pinned
// wire fixtures FROM the engine and the parser THROUGH the shim, so it fails if
// either the shim stops re-exporting the real implementation or a future re-fork
// diverges from the pinned wire format.

import { describe, expect, it } from "vitest";
import { CLAIM_WIRE_FIXTURES } from "@reddb-io/worker/engine";
import { CLAIM_MARKER_VERSION, parseClaimRecords, renderClaimComment } from "../src/core/claim.js";

describe("claim wire compatibility through the shim", () => {
  it("parses every pinned wire fixture identically to the engine", () => {
    for (const fixture of CLAIM_WIRE_FIXTURES) {
      expect(parseClaimRecords([fixture.comment]), fixture.name).toEqual(fixture.expected);
    }
  });

  it("re-exports the single engine implementation, not a fork", async () => {
    const engine = await import("@reddb-io/worker/engine");
    expect(parseClaimRecords).toBe(engine.parseClaimRecords);
    expect(renderClaimComment).toBe(engine.renderClaimComment);
    expect(CLAIM_MARKER_VERSION).toBe(engine.CLAIM_MARKER_VERSION);
  });
});
