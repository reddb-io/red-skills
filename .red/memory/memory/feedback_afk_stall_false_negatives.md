---
name: afk-stall-false-negatives
description: "Never call an AFK worker \"stuck\" from the monitor alone — verify the process tree first to avoid false negatives"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6356866f-54bb-435d-8f7d-e02bd9108407
---

When `/dev:afk monitor` shows a worker with `last_stream_line=""` and `cpu=0%` for many minutes, do not call it stuck or recommend the bash-hang diagnostic without first checking the process tree.

**Why:** The two signals are deceptive in normal operation:
- `last_stream_line=""` means the claude/codex stream has been silent since the last reset — but that is the *expected* state any time the inner agent is **blocked waiting on a synchronous Bash tool call** (e.g. a long vitest/build/cargo run). Claude cannot emit anything until the tool returns.
- `cpu=0%` is reported for the **orchestrator bash wrapper**, not the inner test/build process. A test suite saturating 8 cores via node workers still shows `cpu=0%` on the heartbeat because the wrapper is just `wait`ing.

A real bash-hang and a healthy long-running test invocation look **identical** in the monitor. Calling the latter "stuck" wastes the user's attention and risks recommending a kill of productive work.

**How to apply:** Before flagging a worker as stuck or recommending intervention:
1. `cat .red/tmp/work-{id}-i{N}/afk.pid` → get orchestrator pid.
2. `pstree -p <pid>` → look at the leaves. If you see `node`/`vitest`/`esbuild`/`cargo`/`tsc`/`pnpm` actively running, the worker is busy, not stuck.
3. If the leaf is `timeout N pnpm exec vitest …` (or similar), the worst-case wait is `N` seconds — note the etime and the cap.
4. Look at the test/build's own output (`/tmp/test.log`, `.red/tmp/work-*/worktree/...`) for actively-updating lines.
5. Only after confirming no productive descendant exists is it fair to suggest bash-hang diagnosis.

The genuine bash-hang signature is a `bash -c 'until grep ... ; do sleep 5; done'` descendant with no producer process — see [[afk-stall-enforcement]] for the supervisor reaper that handles those.
