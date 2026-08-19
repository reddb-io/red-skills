import { sha256 } from "@reddb-io/brain-store/hash.js";
import type { ChannelEvent } from "@reddb-io/brain-store/channel-bridge.js";
import type { CaptureInput } from "@reddb-io/brain-store/store.js";

export interface EventArtifactMapInput {
  event: ChannelEvent;
  sourceAgent?: string;
}

export class EventArtifactMapper {
  map({ event, sourceAgent }: EventArtifactMapInput): CaptureInput {
    return {
      title: eventTitle(event),
      content: eventContent(event),
      kind: "event",
      tags: eventTags(event),
      sourceAgent: sourceAgent ?? "brain.ingest-events",
      sourceRunner: "hermes",
      sourceSession: eventUniqueKey(event),
      metadata: eventMetadata(event),
    };
  }
}

export function eventUniqueKey(event: ChannelEvent): string {
  if (event.id) return `evt:${event.id}`;
  if (event.cursor != null) return `cursor:${String(event.cursor)}`;
  return `hash:${sha256(
    JSON.stringify({
      platform: event.platform ?? null,
      target: event.target ?? null,
      timestamp: event.timestamp ?? null,
      message: event.message ?? null,
    }),
  )}`;
}

function eventTitle(event: ChannelEvent): string {
  const parts: string[] = [];
  if (event.platform) parts.push(event.platform);
  if (event.target) parts.push(event.target);
  const location = parts.length > 0 ? `[${parts.join(":")}]` : "[channel-event]";
  if (event.message) {
    const snippet = event.message.slice(0, 60).replace(/\n/g, " ");
    return `${location} ${snippet}`;
  }
  if (event.type) return `${location} ${event.type}`;
  return `${location} event`;
}

function eventContent(event: ChannelEvent): string {
  const lines: string[] = [];
  if (event.message) lines.push(event.message);
  if (event.type) lines.push(`type: ${event.type}`);
  if (event.platform) lines.push(`platform: ${event.platform}`);
  if (event.target) lines.push(`target: ${event.target}`);
  if (event.timestamp) lines.push(`timestamp: ${event.timestamp}`);
  return lines.join("\n") || JSON.stringify(event.raw);
}

function eventTags(event: ChannelEvent): string[] {
  const tags = new Set(["channel-event"]);
  if (event.platform) tags.add(event.platform);
  if (event.type) tags.add(event.type);
  return Array.from(tags);
}

function eventMetadata(event: ChannelEvent): Record<string, unknown> {
  const meta: Record<string, unknown> = { event_key: eventUniqueKey(event) };
  if (event.id != null) meta.event_id = event.id;
  if (event.cursor != null) meta.cursor = event.cursor;
  if (event.timestamp != null) meta.timestamp = event.timestamp;
  if (event.platform != null) meta.platform = event.platform;
  if (event.target != null) meta.target = event.target;
  if (event.sessionKey != null) meta.session_key = event.sessionKey;
  if (event.type != null) meta.event_type = event.type;
  return meta;
}
