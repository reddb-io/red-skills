import { describe, expect, it } from "vitest";
import {
  CHANNEL_ENV_VAR,
  DEFAULT_CHANNEL,
  channelReleaseRef,
  normalizeChannel,
  RELEASE_CHANNELS,
  resolveChannel,
} from "./channel.js";

describe("normalizeChannel", () => {
  it("accepts the canonical channel names", () => {
    expect(normalizeChannel("stable")).toBe("stable");
    expect(normalizeChannel("canary")).toBe("canary");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeChannel(" Stable ")).toBe("stable");
    expect(normalizeChannel("CANARY")).toBe("canary");
  });

  it("returns null for unknown, empty, or missing values", () => {
    expect(normalizeChannel("beta")).toBeNull();
    expect(normalizeChannel("")).toBeNull();
    expect(normalizeChannel("   ")).toBeNull();
    expect(normalizeChannel(undefined)).toBeNull();
    expect(normalizeChannel(null)).toBeNull();
  });
});

describe("resolveChannel precedence", () => {
  it("defaults to stable with no signal — today's behaviour", () => {
    expect(resolveChannel()).toBe("stable");
    expect(resolveChannel({})).toBe(DEFAULT_CHANNEL);
    expect(DEFAULT_CHANNEL).toBe("stable");
  });

  it("config value overrides the default", () => {
    expect(resolveChannel({ configValue: "canary" })).toBe("canary");
  });

  it("env wins over config", () => {
    expect(
      resolveChannel({
        env: { [CHANNEL_ENV_VAR]: "stable" },
        configValue: "canary",
      }),
    ).toBe("stable");
    expect(
      resolveChannel({
        env: { [CHANNEL_ENV_VAR]: "canary" },
        configValue: "stable",
      }),
    ).toBe("canary");
  });

  it("ignores unknown env/config and falls through to the next source", () => {
    // Unknown env falls back to the (valid) config value.
    expect(
      resolveChannel({ env: { [CHANNEL_ENV_VAR]: "beta" }, configValue: "canary" }),
    ).toBe("canary");
    // Unknown config falls back to the default.
    expect(resolveChannel({ configValue: "nonsense" })).toBe("stable");
  });

  it("exposes the canonical channel list", () => {
    expect([...RELEASE_CHANNELS]).toEqual(["stable", "canary"]);
  });
});

describe("channelReleaseRef", () => {
  it("stable displays the installed version tag — preserves existing boot output", () => {
    expect(channelReleaseRef("stable", "1.209.0")).toBe("v1.209.0");
  });

  it("canary displays the npm canary dist-tag — version-independent", () => {
    expect(channelReleaseRef("canary", "1.209.0")).toBe("canary");
    expect(channelReleaseRef("canary", "")).toBe("canary");
  });
});
