---
name: afk-stall-enforcement
description: "AFK supervisor's passive stall detector flags but never reaps — inner-agent polling-loop drift can hang a worker indefinitely; prompt-level rules alone are insufficient"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2099e78b-ff36-40eb-bfc5-bc011ac0ade8
---

AFK supervisor stalls must have a reaper, not just a flag. Prompt-level rules in `AGENT-PROMPT.md` (no untimed polling loops) are routinely violated by drifting inner agents, and the Sentinel Watchdog only fires *after* `<promise>DONE/BLOCKED</promise>` is emitted — so a polling-loop hang prevents the very signal the watchdog needs.

**Why:** On 2026-05-26, worker wVGPW spent ~54 min on #178 with `npm exec vitest` stuck at 0% CPU for 26+ min behind an untimed claude Task-tool polling loop. Supervisor's `[⏸️ stalled]` flag fired at 10 min and just sat there per supervisor.sh:34 ("supervisor does NOT kill or restart stalled workers — surfacing is the entire job"). I had to SIGKILL the tree manually and restore `ready-for-agent` by hand because the orchestrator's SIGTERM handler can't preempt a hung inner-agent pipeline.

**How to apply:** When designing autonomous loops with internal "agent drift" risk, every soft signal (stall flag, lint warning, schema check) needs a hard counterpart at a longer threshold. Document the explicit no-action rule when you make one (like supervisor.sh:34 does), so the next person knows it was a deliberate choice and not an oversight — and so they can challenge it.
