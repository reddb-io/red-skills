import { describe, expect, test } from "vitest";
import { codexSkillEvents, type CodexHookPayload } from "../src/skill-codex.js";
import { parseSkillEvent } from "../src/skill-events.js";

const CTX = { now: "2026-05-22T16:00:00.000Z" } as const;

describe("Codex skill telemetry adapter", () => {
  test("maps a SKILL.md read to a viewed event", () => {
    const payload: CodexHookPayload = {
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: "read_file",
      tool_input: { path: "/plugins/dev/skills/engineering/tdd/SKILL.md" },
    };

    const events = codexSkillEvents(payload, CTX);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "viewed",
      runner: "codex",
      session_id: "session-1",
      turn_id: "turn-1",
      name: "tdd",
      source_kind: "plugin",
      path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
    });
    // The emitted event still satisfies the Memory-owned contract.
    expect(() => parseSkillEvent(events[0])).not.toThrow();
  });

  test("maps a skill tool PreToolUse to a used event", () => {
    const payload: CodexHookPayload = {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: "skill",
      tool_input: { skill: "dev:tdd", args: "build the parser" },
    };

    const events = codexSkillEvents(payload, CTX);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "used",
      name: "dev:tdd",
      source_kind: "plugin",
      path: "skill://dev:tdd",
      runner: "codex",
    });
    // No free-text args leak into the contract.
    expect(JSON.stringify(events[0])).not.toContain("build the parser");
  });

  test("maps a skill tool PostToolUse to a result event with derived status", () => {
    const succeeded = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "skill",
        tool_input: { skill: "dev:tdd" },
        tool_response: { success: true },
      },
      CTX,
    );
    expect(succeeded[0]).toMatchObject({ event_type: "result", result: { status: "succeeded" } });

    const failed = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "skill",
        tool_input: { skill: "dev:tdd" },
        tool_response: { is_error: true },
      },
      CTX,
    );
    expect(failed[0]).toMatchObject({ event_type: "result", result: { status: "failed" } });

    const unknown = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "skill",
        tool_input: { skill: "dev:tdd" },
      },
      CTX,
    );
    expect(unknown[0]).toMatchObject({ event_type: "result", result: { status: "unknown" } });
  });

  test("maps apply_patch add/update of a SKILL.md to changed/patched events", () => {
    const added = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n*** Add File: /home/me/.codex/skills/notes/SKILL.md\n+hello\n*** End Patch",
        },
      },
      CTX,
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ event_type: "changed", name: "notes", source_kind: "user" });

    const updated = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n*** Update File: /home/me/.codex/skills/notes/SKILL.md\n@@\n+hi\n*** End Patch",
        },
      },
      CTX,
    );
    expect(updated[0]).toMatchObject({ event_type: "patched", name: "notes" });
  });

  test("emits one event per SKILL.md touched by a multi-file apply_patch", () => {
    const events = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_input: {
          input:
            "*** Begin Patch\n" +
            "*** Update File: /plugins/dev/skills/a/SKILL.md\n@@\n+x\n" +
            "*** Add File: /plugins/dev/skills/b/SKILL.md\n+y\n" +
            "*** Update File: /src/index.ts\n@@\n+z\n" +
            "*** End Patch",
        },
      },
      CTX,
    );
    // Only the two SKILL.md files produce events; index.ts is ignored.
    expect(events).toHaveLength(2);
    expect(events.map((e) => `${e.name}:${e.event_type}`).sort()).toEqual([
      "a:patched",
      "b:changed",
    ]);
  });

  test("also reads a structured apply_patch changes map", () => {
    const events = codexSkillEvents(
      {
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_name: "apply_patch",
        tool_input: {
          changes: {
            "/plugins/dev/skills/a/SKILL.md": { type: "update" },
            "/plugins/dev/skills/b/SKILL.md": { type: "add" },
          },
        },
      },
      CTX,
    );
    expect(events.map((e) => `${e.name}:${e.event_type}`).sort()).toEqual([
      "a:patched",
      "b:changed",
    ]);
  });

  test("generates deterministic, replay-stable event ids", () => {
    const payload: CodexHookPayload = {
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: "skill",
      tool_input: { skill: "dev:tdd" },
      call_id: "call_123",
    };

    const first = codexSkillEvents(payload, CTX);
    const second = codexSkillEvents(payload, CTX);
    expect(first[0].event_id).toBe(second[0].event_id);

    // A different event type on the same call produces a different id.
    const result = codexSkillEvents({ ...payload, hook_event_name: "PostToolUse" }, CTX);
    expect(result[0].event_id).not.toBe(first[0].event_id);

    // A different turn produces a different id.
    const otherTurn = codexSkillEvents({ ...payload, turn_id: "turn-2" }, CTX);
    expect(otherTurn[0].event_id).not.toBe(first[0].event_id);
  });

  test("falls open on malformed, partial, or unrelated payloads", () => {
    // Missing session id.
    expect(codexSkillEvents({ tool_name: "skill", tool_input: { skill: "x" } })).toEqual([]);
    // Skill tool with no skill name.
    expect(
      codexSkillEvents({ session_id: "s", tool_name: "skill", tool_input: {} }),
    ).toEqual([]);
    // A normal, non-skill tool turn.
    expect(
      codexSkillEvents({
        session_id: "s",
        tool_name: "shell",
        tool_input: { command: ["ls"] },
      }),
    ).toEqual([]);
    // apply_patch on a non-skill file.
    expect(
      codexSkillEvents({
        session_id: "s",
        tool_name: "apply_patch",
        tool_input: { input: "*** Begin Patch\n*** Update File: /src/index.ts\n@@\n+x\n*** End Patch" },
      }),
    ).toEqual([]);
    // Garbage input never throws.
    expect(codexSkillEvents(null as unknown as CodexHookPayload)).toEqual([]);
    expect(codexSkillEvents(undefined as unknown as CodexHookPayload)).toEqual([]);
    expect(codexSkillEvents(42 as unknown as CodexHookPayload)).toEqual([]);
  });

  test("falls back to a session-derived turn id when none is supplied", () => {
    const events = codexSkillEvents(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-9",
        tool_name: "skill",
        tool_input: { skill: "dev:tdd" },
      },
      CTX,
    );
    expect(events[0].turn_id).toBe("t:session-9");
  });

  test("prefers the context turn id over the payload turn id", () => {
    const events = codexSkillEvents(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        turn_id: "payload-turn",
        tool_name: "skill",
        tool_input: { skill: "dev:tdd" },
      },
      { turnId: "ctx-turn", now: CTX.now },
    );
    expect(events[0].turn_id).toBe("ctx-turn");
  });
});
