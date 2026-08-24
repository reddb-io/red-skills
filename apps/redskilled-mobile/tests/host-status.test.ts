import { describe, expect, it } from "vitest";

import {
  deriveHostStatus,
  HOST_ONLINE_WINDOW_MS,
  HOST_STALE_WINDOW_MS,
} from "../src/domain/host-status";

describe("the host link status derives from the last answered read", () => {
  const now = 1_000_000;

  it("says connecting before any read has answered, never online", () => {
    expect(deriveHostStatus(null, now)).toBe("connecting");
  });

  it("a fresh answer is online", () => {
    expect(deriveHostStatus(now - 1_000, now)).toBe("online");
    expect(deriveHostStatus(now - (HOST_ONLINE_WINDOW_MS - 1), now)).toBe("online");
  });

  it("an aging answer is stale", () => {
    expect(deriveHostStatus(now - HOST_ONLINE_WINDOW_MS, now)).toBe("stale");
    expect(deriveHostStatus(now - (HOST_STALE_WINDOW_MS - 1), now)).toBe("stale");
  });

  it("silence past the stale window is an outage, not a quiet host", () => {
    expect(deriveHostStatus(now - HOST_STALE_WINDOW_MS, now)).toBe("unreachable");
  });
});
