import { z } from "zod";
import { contentHash } from "./hash.js";
import type { MemoryNode } from "./schema.js";
import type { MemoryStore } from "./graph-store.js";

const SAFE_TEXT_MAX = 512;
const SAFE_PATH_MAX = 2048;

const safeString = (label: string, max = SAFE_TEXT_MAX) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is too large`);

export const SKILL_EVENT_TYPES = ["viewed", "used", "result", "changed", "patched"] as const;
export const SKILL_RESULT_STATUSES = [
  "succeeded",
  "failed",
  "abandoned",
  "blocked",
  "unknown",
] as const;

export type SkillEventType = (typeof SKILL_EVENT_TYPES)[number];
export type SkillResultStatus = (typeof SKILL_RESULT_STATUSES)[number];

const resultSchema = z
  .object({
    status: z.enum(SKILL_RESULT_STATUSES),
    duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
    error_class: safeString("error_class", 160).optional(),
    error_code: safeString("error_code", 160).optional(),
    error_stage: safeString("error_stage", 160).optional(),
  })
  .strict();

const eventSchema = z
  .object({
    event_type: z.enum(SKILL_EVENT_TYPES),
    event_id: safeString("event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    session_id: safeString("session_id", 200),
    turn_id: safeString("turn_id", 200),
    name: safeString("name", 200),
    source_kind: safeString("source_kind", 80),
    path: safeString("path", SAFE_PATH_MAX),
    runner: safeString("runner", 80),
    result: resultSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.event_type === "result" && !event.result) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "result events require a safe result payload",
      });
    }
    if (event.event_type !== "result" && event.result) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "result payloads are only valid on result events",
      });
    }
  });

export type SkillEvent = z.infer<typeof eventSchema>;

export interface SkillEventIngestReport {
  events: number;
  nodes: number;
}

export function parseSkillEventInput(input: string): SkillEvent[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("skill event input is empty");

  const raw = parseJsonOrJsonl(trimmed);
  const events = Array.isArray(raw) ? raw : [raw];
  if (events.length === 0) throw new Error("skill event batch is empty");
  return events.map((event, index) => parseSkillEvent(event, index));
}

export function parseSkillEvent(input: unknown, index = 0): SkillEvent {
  const parsed = eventSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : `event[${index}]`;
      const extras =
        "keys" in issue && Array.isArray(issue.keys) ? ` (${issue.keys.join(", ")})` : "";
      return `${path}: ${issue.message}${extras}`;
    })
    .join("; ");
  throw new Error(`invalid skill event: ${detail}`);
}

export async function ingestSkillEvents(
  store: MemoryStore,
  events: readonly SkillEvent[],
): Promise<SkillEventIngestReport> {
  let nodes = 0;
  for (const event of events) {
    await store.upsertNode(skillEventToNode(event));
    nodes += 1;
  }
  return { events: events.length, nodes };
}

export function skillEventToNode(event: SkillEvent): MemoryNode {
  const result = event.result;
  const resultSummary = result
    ? ` result=${result.status}${result.duration_ms != null ? ` duration=${result.duration_ms}ms` : ""}`
    : "";
  const title = `${event.name} ${event.event_type}`;
  return {
    label: `skill-event:${event.event_id}`,
    node_type: "workflow",
    properties: {
      title,
      summary: `${event.runner} ${event.event_type} ${event.name}${resultSummary}`,
      content:
        `${event.timestamp} ${event.runner} ${event.event_type} ` +
        `${event.name} (${event.path})${resultSummary}`,
      tags: ["skill-telemetry", `skill:${event.name}`, `runner:${event.runner}`],
      confidence: "EXTRACTED",
      source: "skill-telemetry",
      hash: contentHash("skill-event", event.event_id),
      skill_event: event,
    },
  };
}

function parseJsonOrJsonl(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (jsonErr) {
    const lines = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) throw jsonErr;
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(
          `invalid JSONL at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
