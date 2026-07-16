# Pi session samples (#565)

Real captures from `@mariozechner/pi-coding-agent@0.73.1` (the version pinned in
`src/InitService.ts`), used to settle the open questions for pi resume support.

## Files

### `stream-stdout.jsonl`

Full **stdout** of `pi -p --mode json --no-session "say hi"` (stderr discarded).
Shows the event stream a single iteration emits — what `parsePiStreamLine` parses.

- **Line 1 is the session header**: `{"type":"session","version":3,"id":"<uuid>","cwd":"<path>"}`.
  This is the only place the session id appears on the stream — `agent_start` carries none.
  → `parsePiStreamLine` should emit `{type:"session_id", sessionId}` from `obj.type === "session"`.
- Then `agent_start` → `turn_start` → `message_start`/`message_update`(`text_delta`)/`message_end`
  → `turn_end` → `agent_end`. Matches the events the current parser already handles.

### `resumed-session.jsonl`

On-disk session file after a **two-turn resume** (mutate-in-place), copied verbatim from
`~/.pi/agent/sessions/--home-mattpocock-repos-ai-sandcastle--/<ISO>_<uuid>.jsonl`.

Demonstrates the persisted JSONL shape:

- entry order: `session` (header, carries `cwd`) → `model_change` → `thinking_level_change`
  → `message`(user) → `message`(assistant) → `message`(user) → `message`(assistant)
- tree structure via `id` / `parentId` (8-char hex); header has no `id`/`parentId`
- **`cwd` appears only in the header line** — no other entry embeds it
- the second user/assistant pair was appended by `pi --session <id> "..."`: **same file, same
  session id, no new file** — confirming resume = append-in-place.

## Provenance

Captured 2026-05-29 on the host (`pi` 0.73.1, provider `openai-codex`/`gpt-5.5`).
Throwaway "say hi" / "remember 42" prompts — no sensitive content.
