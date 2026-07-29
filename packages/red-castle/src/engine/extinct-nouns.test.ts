import { describe, expect, it } from "vitest";
import {
  FLEET_REMOVED_MESSAGE,
  FleetNamingRemovedError,
  refuseFleetNaming,
} from "./extinct-nouns.js";

describe("naming a fleet after its removal", () => {
  it("passes an absent name through, so a call site can guard unconditionally", () => {
    expect(() => refuseFleetNaming(undefined)).not.toThrow();
    expect(() => refuseFleetNaming(null)).not.toThrow();
    expect(() => refuseFleetNaming("")).not.toThrow();
  });

  it("refuses a named fleet with the replacement, not an internal error", () => {
    expect(() => refuseFleetNaming("nightly")).toThrow(FleetNamingRemovedError);
    try {
      refuseFleetNaming("nightly");
      expect.unreachable("a named fleet must be refused");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('"nightly"');
      expect(message).toContain("project_start");
      expect(message).toContain("--selector");
    }
  });

  it("states the replacement route rather than only the removal", () => {
    for (const route of ["project_status", "project_resize", "project_stop", "--runner", "--base"]) {
      expect(FLEET_REMOVED_MESSAGE).toContain(route);
    }
  });
});
