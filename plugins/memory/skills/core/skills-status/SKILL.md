---
name: skills-status
description: Diagnose Skill telemetry status and recent Skill usage events. Use when checking whether self-improvement telemetry is enabled, whether skills are being observed, or before running the report-only Skill curator. Graph mode with `--skill-telemetry` provides full output; all other states explain what is missing.
---

# memory skills-status

Read-only diagnostic for the self-improvement loop. It shows whether Skill telemetry is uninitialized, unavailable, or enabled; when enabled, it lists observed skills, recent events, and outcome counts.

<what-to-do>

**Run the skills-status diagnostic, interpret the telemetry state, and recommend the next concrete action — never mutate skills from this command.**

## 1. Run the diagnostic

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" status skills
```

Use `--all` to include bundled plugin/hub skills, and `--json` when another script needs structured output.

## 2. Interpret the state

- `uninitialized` — Memory is not initialized. Recommend `memory init --mode graph --skill-telemetry` if the user wants self-improvement telemetry.
- `no-op` — Memory exists but is not graph mode. Skill telemetry needs graph mode.
- `unavailable` — graph mode exists, but the explicit `skillTelemetry` opt-in is off.
- `enabled` — read partitioned rollups and recent events. Rollups are stored per skill/event marker so telemetry can scale beyond the engine KV value cap.

Do not treat non-enabled states as errors; this command is a diagnostic and exits cleanly.

## 3. Decide the next action

- If telemetry is enabled and the user wants maintenance recommendations, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" curate skills
```

- If there are archive candidates and the user wants to act, use the `dev` plugin's `/curate` workflow. The Memory plugin's curator is report-only.
- If events are empty, tell the user telemetry is enabled but no skill use has been observed yet.

## DOs / DON'Ts

- ✅ Run before `/curate` so you know whether telemetry is collecting evidence.
- ✅ Keep default output focused on Curatable skills; use `--all` for bundled read-only skills.
- ❌ Do not mutate skills from this command.
- ❌ Do not infer skill quality from one failure; use curator thresholds and human review.

</what-to-do>
