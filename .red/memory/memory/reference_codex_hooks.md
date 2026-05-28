---
name: reference-codex-hooks
description: "Codex CLI hook events, plugin bundling, and the PreCompact gap vs Claude Code — for red-skills multi-runner hook work"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 5aab3adf-a223-415d-b854-dc9703e90e44
---

Codex CLI now has a hooks system (docs: https://developers.openai.com/codex/hooks).

**Events:** `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `Stop`. **No PreCompact / compaction / context-trim event exists** — this is the key gap vs Claude Code, and it removes the anti-goldfish "flush before context death" safety net for the `memory` plugin.

**Plugin bundling:** a Codex plugin declares hooks in `.codex-plugin/plugin.json` via `"hooks": "./hooks/hooks.json"` (also accepts an array or inline object; default path `hooks/hooks.json`). Gated behind `[features].plugin_hooks = true`, **off by default** — users must opt in.

**Payload (stdin):** `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode}` (+ `turn_id` on turn-scoped events). Inject context via `systemMessage` or `hookSpecificOutput.additionalContext`; deny via exit 2 or `permissionDecision`. Differs from Claude Code's payload/return shape, so a per-runner adapter is needed.

Codex file edits flow through `apply_patch` (so a `PostToolUse` matcher uses `apply_patch`, not Claude's `Edit|Write`).

As of 2026-05-21 the red-skills `dev` and `memory` plugins expose **no** manifest hooks to either runtime. Memory lifecycle hooks are [[reference-codex-hooks]]'s consumer — slice #55 on reddb-io/red-skills (still open) — which now carries the Codex-parity mapping in a comment.
