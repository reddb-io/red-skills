import { describe, expect, it } from "vitest";
import type { ChannelEvent } from "@reddb-io/brain-store/channel-bridge.js";
import { EventArtifactMapper, eventUniqueKey } from "../src/event-artifact-mapper.js";

describe("EventArtifactMapper", () => {
  const mapper = new EventArtifactMapper();

  it("maps a full channel event to a kind:event artifact", () => {
    const event: ChannelEvent = {
      id: "evt-1",
      cursor: 41,
      type: "message",
      platform: "slack",
      target: "slack:#engineering",
      sessionKey: "slack:engineering",
      timestamp: "2026-06-04T12:00:00.000Z",
      message: "release train is green",
      raw: {},
    };
    const input = mapper.map({ event });

    expect(input.kind).toBe("event");
    expect(input.sourceRunner).toBe("hermes");
    expect(input.sourceSession).toBe("evt:evt-1");
    expect(input.sourceAgent).toBe("brain.ingest-events");
    expect(input.title).toContain("[slack:slack:#engineering]");
    expect(input.title).toContain("release train is green");
    expect(input.tags).toContain("channel-event");
    expect(input.tags).toContain("slack");
    expect(input.tags).toContain("message");
    expect(input.content).toContain("release train is green");
    expect(input.content).toContain("platform: slack");
    expect(input.metadata).toMatchObject({
      event_key: "evt:evt-1",
      event_id: "evt-1",
      cursor: 41,
      timestamp: "2026-06-04T12:00:00.000Z",
      platform: "slack",
      target: "slack:#engineering",
      session_key: "slack:engineering",
      event_type: "message",
    });
  });

  it("accepts a custom sourceAgent", () => {
    const event: ChannelEvent = { id: "evt-99", message: "ping", raw: {} };
    const input = mapper.map({ event, sourceAgent: "my-agent" });
    expect(input.sourceAgent).toBe("my-agent");
  });

  it("produces stable output across multiple calls for the same event", () => {
    const event: ChannelEvent = {
      id: "evt-42",
      type: "message",
      platform: "discord",
      target: "discord:#ops",
      message: "deploy completed",
      raw: { extra: "ignored" },
    };
    const a = mapper.map({ event });
    const b = mapper.map({ event });

    expect(a.title).toBe(b.title);
    expect(a.content).toBe(b.content);
    expect(a.tags).toEqual(b.tags);
    expect(a.sourceSession).toBe(b.sourceSession);
    expect(a.kind).toBe(b.kind);
  });

  it("uses cursor as unique key when no event id is present", () => {
    const event: ChannelEvent = { cursor: 99, message: "ping", raw: {} };
    const input = mapper.map({ event });
    expect(input.sourceSession).toBe("cursor:99");
  });

  it("derives a deterministic hash key for events with neither id nor cursor", () => {
    const event: ChannelEvent = {
      platform: "slack",
      target: "#general",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: "hello world",
      raw: {},
    };
    const key1 = eventUniqueKey(event);
    const key2 = eventUniqueKey(event);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^hash:[a-f0-9]{64}$/);
  });

  it("produces different hash keys for events with different messages", () => {
    const base = { platform: "slack", target: "#general", timestamp: "2026-01-01T00:00:00.000Z", raw: {} };
    const key1 = eventUniqueKey({ ...base, message: "hello" });
    const key2 = eventUniqueKey({ ...base, message: "goodbye" });
    expect(key1).not.toBe(key2);
  });

  it("handles an event with only raw data gracefully", () => {
    const event: ChannelEvent = { raw: { body: "opaque" } };
    const input = mapper.map({ event });

    expect(input.kind).toBe("event");
    expect(input.title).toBe("[channel-event] event");
    expect(input.content).toBeTruthy();
    expect(input.tags).toContain("channel-event");
    expect(input.sourceSession).toMatch(/^hash:/);
  });

  it("uses type as title fallback when message is absent", () => {
    const event: ChannelEvent = { type: "presence_change", platform: "slack", raw: {} };
    const input = mapper.map({ event });
    expect(input.title).toContain("presence_change");
  });

  it("truncates long messages to 60 chars in the title", () => {
    const long = "a".repeat(120);
    const event: ChannelEvent = { id: "x", message: long, raw: {} };
    const input = mapper.map({ event });
    const titleWithoutPrefix = input.title.replace(/^\[[^\]]*\] /, "");
    expect(titleWithoutPrefix.length).toBeLessThanOrEqual(60);
  });
});
