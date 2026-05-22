import { describe, expect, test } from "vitest";
import { claudeSkillEvents, type ClaudeHookPayload } from "../src/skill-claude.js";
import { parseSkillEvent } from "../src/skill-events.js";

const CTX = { turnId: "turn-1", now: "2026-05-22T16:00:00.000Z" } as const;

describe("Claude skill telemetry adapter", () => {
  test("maps a SKILL.md Read to a viewed event", () => {
    const payload: ClaudeHookPayload = {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      tool_name: "Read",
      tool_input: { file_path: "/plugins/dev/skills/engineering/tdd/SKILL.md" },
    };

    const events = claudeSkillEvents(payload, CTX);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "viewed",
      runner: "claude",
      session_id: "session-1",
      turn_id: "turn-1",
      name: "tdd",
      source_kind: "plugin",
      path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
    });
    // The emitted event still satisfies the Memory-owned contract.
    expect(() => parseSkillEvent(events[0])).not.toThrow();
  });

  test("maps a Skill tool PreToolUse to a used event", () => {
    const payload: ClaudeHookPayload = {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      tool_name: "Skill",
      tool_input: { skill: "dev:tdd", args: "build the parser" },
    };

    const events = claudeSkillEvents(payload, CTX);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "used",
      name: "dev:tdd",
      source_kind: "plugin",
      path: "skill://dev:tdd",
      runner: "claude",
    });
    // No free-text args leak into the contract.
    expect(JSON.stringify(events[0])).not.toContain("build the parser");
  });

  test("maps a Skill tool PostToolUse to a result event with derived status", () => {
    const succeeded = claudeSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Skill",
        tool_input: { skill: "dev:tdd" },
        tool_response: { success: true },
      },
      CTX,
    );
    expect(succeeded[0]).toMatchObject({ event_type: "result", result: { status: "succeeded" } });

    const failed = claudeSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Skill",
        tool_input: { skill: "dev:tdd" },
        tool_response: { is_error: true },
      },
      CTX,
    );
    expect(failed[0]).toMatchObject({ event_type: "result", result: { status: "failed" } });

    const unknown = claudeSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Skill",
        tool_input: { skill: "dev:tdd" },
      },
      CTX,
    );
    expect(unknown[0]).toMatchObject({ event_type: "result", result: { status: "unknown" } });
  });

  test("maps SKILL.md writes and edits to changed/patched events", () => {
    const changed = claudeSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Write",
        tool_input: { file_path: "/home/me/.claude/skills/notes/SKILL.md" },
      },
      CTX,
    );
    expect(changed[0]).toMatchObject({ event_type: "changed", name: "notes", source_kind: "user" });

    const patched = claudeSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Edit",
        tool_input: { file_path: "/home/me/.claude/skills/notes/SKILL.md" },
      },
      CTX,
    );
    expect(patched[0]).toMatchObject({ event_type: "patched", name: "notes" });
  });

  test("generates deterministic, replay-stable event ids", () => {
    const payload: ClaudeHookPayload = {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      tool_name: "Skill",
      tool_input: { skill: "dev:tdd" },
      tool_use_id: "toolu_123",
    };

    const first = claudeSkillEvents(payload, CTX);
    const second = claudeSkillEvents(payload, CTX);
    expect(first[0].event_id).toBe(second[0].event_id);

    // A different event type on the same call produces a different id.
    const result = claudeSkillEvents({ ...payload, hook_event_name: "PostToolUse" }, CTX);
    expect(result[0].event_id).not.toBe(first[0].event_id);

    // A different turn produces a different id.
    const otherTurn = claudeSkillEvents(payload, { ...CTX, turnId: "turn-2" });
    expect(otherTurn[0].event_id).not.toBe(first[0].event_id);
  });

  test("falls open on malformed, partial, or unrelated payloads", () => {
    // Missing session id.
    expect(claudeSkillEvents({ tool_name: "Skill", tool_input: { skill: "x" } })).toEqual([]);
    // Skill tool with no skill name.
    expect(
      claudeSkillEvents({ session_id: "s", tool_name: "Skill", tool_input: {} }),
    ).toEqual([]);
    // A normal, non-skill tool turn.
    expect(
      claudeSkillEvents({
        session_id: "s",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      }),
    ).toEqual([]);
    // Editing a non-skill file.
    expect(
      claudeSkillEvents({
        session_id: "s",
        tool_name: "Edit",
        tool_input: { file_path: "/src/index.ts" },
      }),
    ).toEqual([]);
    // Garbage input never throws.
    expect(claudeSkillEvents(null as unknown as ClaudeHookPayload)).toEqual([]);
    expect(claudeSkillEvents(undefined as unknown as ClaudeHookPayload)).toEqual([]);
    expect(claudeSkillEvents(42 as unknown as ClaudeHookPayload)).toEqual([]);
  });

  test("falls back to a session-derived turn id when none is supplied", () => {
    const events = claudeSkillEvents(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-9",
        tool_name: "Skill",
        tool_input: { skill: "dev:tdd" },
      },
      { now: "2026-05-22T16:00:00.000Z" },
    );
    expect(events[0].turn_id).toBe("t:session-9");
  });
});
