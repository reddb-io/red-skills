# Research: Codex CLI task/subagent orchestration for AFK

Discovery slice for PRD #196 → issue #204. Companion to
[`197-claude-code-surfaces.md`](197-claude-code-surfaces.md), which
covered the Claude side. The two notes together define the cross-runner
contract the AFK task engine must honour.

Scope: enumerate what Codex CLI exposes today that AFK can lean on,
contrast it with the Claude-native plan from #197, and recommend
whether Codex should use native sub-agents (if/when), parallel `codex
exec` lanes, or RedSkills-managed external task phases. JS workflow
files are out of scope here — that question was resolved negatively in
#197.

Sources consulted: this repo's own Codex integration
(`plugins/dev/skills/engineering/afk/runner-codex.md`,
`plugins/dev/.codex-plugin/plugin.json`,
`plugins/dev/hooks/codex.hooks.json`,
`plugins/dev/skills/engineering/afk/scripts/lib/mirror.sh`,
`plugins/dev/skills/engineering/afk/SKILL.md`), the prior
[[reference_codex_hooks]] memory note, and the Codex CLI flag surface
observed in the AFK runner. Where a behaviour is asserted from repo
evidence alone, it's marked **confirmed (repo)**; behaviours we have
only by community pattern are marked **unverified**.

## 1. Confirmed Codex CLI surfaces (today)

| Surface | Form | RedSkills uses today |
| --- | --- | --- |
| Non-interactive exec | `codex exec <prompt>` | yes — AFK inner-agent spawn |
| Working dir | `-C <dir>` | yes (`-C "$WORKTREE"`) |
| Structured event stream | `--json` JSONL on stdout | yes (`item.completed` filter) |
| Final message capture | `--output-last-message <file>` | yes (orchestrator reads file) |
| Sandbox bypass (unattended) | `--sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox` | yes — required for AFK |
| Plugin manifest | `.codex-plugin/plugin.json` | yes (`dev`, `memory`) |
| Skills (markdown) | `skills/<name>/SKILL.md`, invoked as `$skill` | yes |
| Hooks | `hooks/codex.hooks.json` | yes — but only `PreToolUse` wired today |
| MCP servers | `mcpServers` in `plugin.json` | yes |
| Sub-agent UI (presentation only) | runtime "monitor agent" surface, read-only | partial — `/afk fleet` uses it for one read-only progress agent |

What Codex does **not** expose that Claude Code does, based on the same
sources:

| Missing on Codex | Claude Code equivalent | Impact for AFK |
| --- | --- | --- |
| Native sub-agent dispatch API (analog of Claude's `Task` tool with `subagent_type` / packaged `agents/<name>.md`) | `agents/` + `Task` tool | Cannot natively delegate `issue-analyzer`/`task-executor`/`quality-gate` phases to first-class sub-agents — must inline phases through `codex exec` prompts (or, if same-process, through Skill dispatch) |
| Native background-task / progress / `TaskCreate` surface | `TaskCreate`/`TaskUpdate`/`TaskGet` family | AFK Task-mirror sink already detects this (`codex_native_task_available` returns non-zero) and **falls back to the `monitor.sh` dashboard**. No regression — by design. |
| `PreCompact` and most lifecycle hook events | `SessionStart`, `Stop`, `PreCompact`, `UserPromptSubmit`, `PostToolUse`, … | Memory plugin compaction write-back gap already absorbed in [[reference_codex_hooks]]; nothing new here. |
| `agent-teams` / `agent-view` cross-session orchestration runtime | documented Claude runtime | AFK orchestrator already provides its own multi-worker dashboard via `monitor.sh` and `supervisor.sh`; we don't depend on this on either side. |
| Routines (cron-like scheduling) | `routines.md` | Not a blocker — `cron`/systemd timers cover the same need where users want unattended drains; out of scope for this PRD. |
| Documented session resume / replay API | (partial via Claude session ids) | AFK does not depend on resume today — each attempt rebuilds the handoff fresh. Out of scope. |

Status of the **monitor sub-agent** surface, specifically: per
[`runner-codex.md`](../../plugins/dev/skills/engineering/afk/runner-codex.md),
Codex *does* expose a native sub-agent UI for presentation, but the
repo deliberately treats it as **read-only** — the actual worker
processes stay supervised at the OS level. That is the cleanest
practical evidence we have that the Codex sub-agent surface is not
equivalent to Claude's Task tool: if it were, AFK would route workers
through it.

## 2. Mapping AFK phases to Codex today

The PRD's four phases — issue analysis, task execution, quality gate,
blocker reporting — each need an answer on Codex.

| Phase | On Claude Code (per #197) | On Codex (today) | Cost difference |
| --- | --- | --- | --- |
| Issue analysis | Markdown sub-agent under `plugins/dev/agents/issue-analyzer.md`, invoked via Task tool | Inline phase prompt inside the same `codex exec` session, structured JSON requested as part of the prompt **OR** a second short `codex exec` lane reading the issue body | extra process + token cost if separated; otherwise identical |
| Task execution | Markdown sub-agent `task-executor.md` with handoff file | The current `codex exec` AFK invocation already *is* the task executor — no change needed | none |
| Quality gate | Markdown sub-agent `quality-gate.md` parsing test/typecheck/lint/build, emits `completed / blocked / escalation_needed` | The same phase prompt issued after `codex exec` returns, against the captured last-message + post-checks the orchestrator already runs | none — orchestrator post-checks already exist |
| Blocker reporter | Markdown sub-agent `blocker-reporter.md` | `<promise>BLOCKED</promise>` sentinel + Notes element already covers this | none — no new primitive needed |
| Structured completion output | sub-agent return JSON | `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinel + `--output-last-message` file | none — already in production |
| AFK monitor / state visibility | `TaskCreate`/`TaskUpdate` → Claude task view + `monitor.sh` fallback | `monitor.sh` dashboard + one read-only Codex monitor agent (presentation only) | Codex users lose the in-runner task pane but keep the dashboard; documented in `runner-codex.md` |

The key observation: **every phase except issue-analysis already has a
working Codex implementation**, because the inner agent is the
executor, the orchestrator runs the quality gate post-checks
out-of-process, and the `<promise>…</promise>` sentinel + last-message
file already give us structured completion. Only "phase separation" is
the open question.

## 3. Three options for phase decomposition on Codex

### Option A — Single `codex exec`, multi-phase prompt

The orchestrator hands Codex one prompt that internally instructs the
agent to do issue analysis → execution → self-check, emitting
structured markers between phases. The agent stays in one session, in
one process, in one billing event.

- **Pro:** zero new primitives. Works today on the existing
  `codex exec` invocation. No state hand-off between phases — full
  context preserved.
- **Pro:** the AFK contract stays runner-neutral. The same prompt can
  be expanded into separate sub-agent calls on Claude later without
  changing `/afk` itself.
- **Con:** the agent's context window is shared across phases. Long
  executions can blow the analyzer's structured output back into
  noise. Mitigated by emitting analyzer output as the first action and
  caching it in `<agent-notes>` so a retry can skip re-analysis.
- **Con:** harder to model-tier per phase (e.g. `haiku` for analysis,
  `sonnet` for execution) — Codex `--model` is per-process.

### Option B — Parallel / sequential `codex exec` lanes

The orchestrator spawns multiple `codex exec` calls — one for the
analyzer phase, one for execution, one for the quality gate — passing
state between them through files in the iteration directory.

- **Pro:** mirrors the Claude sub-agent decomposition cleanly. Each
  lane has its own context window and can pin a cheaper model for the
  cheap phases.
- **Pro:** isolation — an analyzer that goes off the rails doesn't
  poison the executor's context.
- **Con:** N× process spawn cost and N× token cost (no shared cache
  between lanes). On 50-issue drains this matters.
- **Con:** state hand-off through filesystem is mostly fine, but the
  orchestrator has to define a stable JSON contract per phase —
  exactly the artefact #199–#201 are scoped to produce.

### Option C — RedSkills-managed external task phases (status quo+)

Treat phase decomposition as orchestrator concerns: the orchestrator
runs `gh issue view` for analysis, `codex exec` for execution, and
local `pnpm test|typecheck|lint|build` for the quality gate. Codex is
only ever invoked for the *execution* phase.

- **Pro:** the orchestrator is already doing 90% of this. The quality
  gate is already external post-check. Issue analysis can move into
  the handoff builder (the `## Agent brief` section is, in effect,
  pre-analyzed input).
- **Pro:** lowest token cost per issue.
- **Con:** the analyzer/quality-gate logic is split between bash
  (orchestrator) and prompts (executor). Maintaining the
  cross-runner contract becomes documentation discipline rather than
  shared markdown.

## 4. Recommendation

**Adopt Option C for Codex now, evolve toward A or B only if/when the
phase contract from #199–#201 says so.**

Concretely:

1. **Do not introduce a `.codex-plugin/agents/` directory.** Codex has
   no documented consumer for it. If we add one, it'll be cargo-culted
   from Claude's surface and will mislead users into thinking native
   delegation works on Codex.

2. **Keep the `/afk` contract identical** across runners. Phase
   decomposition (analyzer → executor → quality gate → reporter) lives
   in the orchestrator and in the inner-agent prompt's structure. The
   *file layout* differs:
   - On Claude Code: markdown sub-agents under `plugins/dev/agents/`,
     dispatched via Task tool.
   - On Codex: the same phase descriptions inlined into the inner-agent
     prompt (and into the handoff brief), executed sequentially in one
     `codex exec` session.

3. **Treat the Codex monitor sub-agent as presentation only**, as
   `runner-codex.md` already does. The native sub-agent UI is not a
   delegation API; pretending it is would invite the same kind of
   "phantom primitive" mistake the JS-workflow myth was in #197.

4. **Where future Codex versions ship a real delegation API**, swap
   in Option B by overriding `codex_native_task_available` and adding a
   Codex-specific phase dispatcher next to the existing
   `mirror_sink_codex` adapter — exactly the extension point the AFK
   code already documents in [`scripts/lib/mirror.sh`](../../plugins/dev/skills/engineering/afk/scripts/lib/mirror.sh).

5. **For cost-sensitive issues**, allow `RED_AFK_CODEX_MODEL_*` env
   knobs to pin `--model` per *issue class* (analysis-only issues use a
   cheaper model). This achieves most of Option B's tiering benefit
   without splitting the session.

6. **Documentation parity:** the user-visible message stays "AFK runs
   issues end-to-end with claude or codex; on Codex, phase decomposition
   happens inside the inner-agent prompt rather than as separate
   sub-agents." Avoid implying parity that doesn't exist.

## 5. Compatibility matrix: Claude vs Codex vs Hermes

| Capability | Claude Code (full) | Claude Code (`-p` basic) | Codex | Hermes / fallback |
| --- | --- | --- | --- | --- |
| Inner-agent spawn | `claude` (interactive harness inside `/afk` worker) | `claude -p` non-interactive | `codex exec --json` | runner-specific |
| Phase delegation | native sub-agents via Task tool | sub-agents callable if harness supports Task tool; else inline | inline phases in one session (Option C) | inline phases |
| Background task / progress | `TaskCreate/Update/Get/Stop` | depends on harness | not available — falls back to `monitor.sh` | `monitor.sh` |
| Hooks | `SessionStart`, `Stop`, `PreCompact`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit` | same | only `PreToolUse` wired today (per repo) | n/a |
| Structured completion | last assistant message + `<promise>` sentinel | same | `--output-last-message` + `<promise>` sentinel | sentinel only |
| Exhaustion signal | error messages + auth-cap strings | same | `{"type":"error"}` JSON event + last-message strings | runner-specific |
| Sandbox bypass for unattended runs | `--dangerously-skip-permissions` | same | `--sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox` | n/a |
| Native monitor / sub-agent presentation | session view | none | read-only Codex monitor agent (presentation only) | none |
| Skill plugin format | `.claude-plugin/plugin.json` + `skills/<name>/SKILL.md` | same | `.codex-plugin/plugin.json` + same skills tree | same skills tree |

## 6. Confirmed vs assumed

Confirmed (repo evidence):

- `codex exec` flag set used by AFK (`--json`, `-C`, `--sandbox`,
  `--dangerously-bypass-approvals-and-sandbox`,
  `--output-last-message`, positional prompt).
- Codex JSONL event of interest is `item.completed`.
- Codex exhaustion is detectable via `{type:"error", code:"rate_limit"|"quota_exceeded"}`
  and last-message strings (`usage limit`, `weekly cap`, etc.).
- Codex hook surface used today is `PreToolUse` only
  (`plugins/dev/hooks/codex.hooks.json`); `PreCompact` is absent from
  Codex (memory: [[reference_codex_hooks]]).
- Codex has no native background-task / progress surface comparable to
  Claude's `TaskCreate`; the Task-mirror sink falls back to
  `monitor.sh` and prints a one-line notice. This is the single
  mockable capability probe (`codex_native_task_available`).
- Codex exposes a native sub-agent UI used by `/afk fleet` for a
  read-only monitor agent only.

Unverified / community-pattern (would need a spike before relying on):

- Codex session resume / replay semantics beyond what
  `--output-last-message` already captures.
- Whether a future Codex sub-agent delegation API will accept the same
  markdown frontmatter shape Claude's `agents/` uses.
- Cross-process token caching between sequential `codex exec` lanes.

## 7. Implementation follow-ups

Tagged for the PRD #196 sequence; **no scope change recommended to the
existing breakdown from #197 §6**.

1. **#199 (`issue-analyzer` contract)** — define the structured JSON
   the analyzer emits. The same JSON must be producible by:
   - a Claude markdown sub-agent (`plugins/dev/agents/issue-analyzer.md`);
   - an inlined phase inside the Codex inner-agent prompt;
   - the orchestrator pre-computing it from the issue body + suggested
     skills (Option C path).
2. **#200 (`task-executor`)** — already exists implicitly as the AFK
   inner agent on both runners. Make it explicit on Claude; document
   on Codex that the executor *is* the `codex exec` session.
3. **#201 (`quality-gate`)** — codify the parser contract for
   `completed / blocked / escalation_needed`. Orchestrator post-checks
   feed the same contract regardless of runner; on Claude it can
   additionally be invoked as a sub-agent.
4. **#202 (capability detection + dispatch)** — extend the AFK runner
   resolver to check for delegation surfaces. On Codex, the answer is
   "no native delegation today; inline phases" — exactly Option C.
5. **#203 / #206 (compatibility docs)** — fold the matrix in §5 into
   the public AFK docs once it stabilises.

## 8. Outstanding items for human review (HITL)

- **Token economics of inline phases (Option C) vs sequential lanes
  (Option B).** A spike on a real PRD drain would tell us whether the
  context contamination from a one-session multi-phase prompt is bad
  enough to justify the lane cost. Recommendation: ship Option C,
  instrument analyzer-output retention, revisit only if quality gates
  start failing on Codex more than on Claude.
- **Per-issue model tiering on Codex** — should `/afk` accept a
  per-issue `RED_AFK_CODEX_MODEL` override, or pin one model per
  drain? Recommendation: pin per drain (`/afk --runner codex --model`),
  defer per-phase tiering until a real cost signal demands it.
- **Public copy** — until #204 lands and is reviewed, AFK docs must
  say "phased task execution" for Codex (no "sub-agents"), as #197
  already prescribed. Confirm this wording sticks in #203/#206.
- **Codex sub-agent monitor UX** — the read-only monitor agent is the
  only piece of native Codex UI AFK touches today. Confirm we want to
  *keep* it (it provides nice in-runner status) versus dropping it for
  uniformity with the Claude task-pane fallback path.
