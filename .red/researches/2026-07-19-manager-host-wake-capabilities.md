# Manager Host Wake and Lifecycle-Event Capabilities

Date: 2026-07-19
Query: Which official Claude Code, Codex, and OpenCode hook, event, and session APIs can supply meaningful Manager wakes, what payload and lifecycle guarantees do they make, and where must correctness fall back to deterministic resume/status reconciliation?
Scope: Current public host contracts and current official release/source material for Claude Code, Codex CLI/App Server, and OpenCode plugins/server/SDK. This report distinguishes an event notification from a true model wake. It does not design the final Manager adapter envelope, implement an adapter, or treat external event content as trusted instructions.

## Executive Summary

All three hosts can tell Manager that something meaningful happened. They do not offer the same wake guarantee, and none offers a delivery contract strong enough to make events authoritative.

- **Claude Code has the strongest in-session wake surface.** Command hooks can run asynchronously; `asyncRewake: true` can wake an idle live session when the hook exits `2`. Session-scoped scheduled tasks can submit prompts later, and research-preview Channels can push external events directly into a running session. These paths all depend on a live or backgrounded session. Async hooks have no deduplication, scheduled tasks have no catch-up, and Channel notifications are unacknowledged and can be dropped silently.
- **Codex has strong observation and control surfaces but no hook-native delayed wake.** Published lifecycle hooks are synchronous; handlers configured with `async` are skipped. `Stop` can immediately continue the current turn, and legacy `notify` launches a side-effect process for `agent-turn-complete`, but neither is a delayed wake primitive. A persistent App Server client can observe `thread/*`, `turn/*`, `item/*`, approvals, and hook events, then explicitly call `thread/resume` and `turn/start`; that is a real programmatic wake owned by the external client, not an automatic Codex lifecycle guarantee.
- **OpenCode has the strongest general-purpose server path.** Plugins receive session and permission events and receive an SDK client. Its HTTP server exposes SSE events, `GET /session/status`, and `POST /session/:id/prompt_async`, so a live plugin or supervisor can start an asynchronous prompt in a known session. However, the official OpenCode CLI itself polls `session.status` because transports can miss status events and rechecks live state before accepting a possibly stale idle event.

The common contract should therefore be:

1. A host event is a **best-effort wake hint**, never the state transition itself.
2. Every wake first acquires the Manager effort lease, deduplicates the hint, and performs deterministic reconciliation against the Manager portfolio plus the workflow-owned durable sources.
3. `manager resume` and `manager status`, and every host session-start/resume hook, perform the same full reconciliation even if no event was observed.
4. A host that cannot safely start a model turn records the hint and degrades to reconciliation at the next explicit invocation. Correctness must not depend on an agent remaining alive.
5. Event content is untrusted data. The wake should request reconciliation, not execute text received from Issues, PRs, Channels, webhooks, or host transcripts as instructions.

## Official Sources

### Claude Code

- [Hooks reference](https://code.claude.com/docs/en/hooks) — official event catalog, payload schemas, blocking behavior, async hooks, `asyncRewake`, and lifecycle limitations.
- [Run prompts on a schedule](https://code.claude.com/docs/en/scheduled-tasks) — official `/loop`, cron, `ScheduleWakeup`, restoration, expiry, live-session, and no-catch-up behavior.
- [Channels](https://code.claude.com/docs/en/channels) — official research-preview description of pushes into a running session and availability/security limits.
- [Channels reference](https://code.claude.com/docs/en/channels-reference) — official notification payload and delivery semantics, including no acknowledgement and silent drops.
- [CLI reference](https://code.claude.com/docs/en/cli-reference) — official session identity, `--resume`, `--continue`, background agents, and machine-readable agent listing.
- [Headless mode](https://code.claude.com/docs/en/headless) — official stream/session metadata and non-interactive resume behavior.
- [Claude Code v2.1.215](https://github.com/anthropics/claude-code/releases/tag/v2.1.215) — official latest release at research time.

### Codex

- [Hooks](https://developers.openai.com/codex/hooks) — official release behavior for current Codex lifecycle hooks, inputs, continuation, handler concurrency, and the unsupported `async` option.
- [Advanced configuration: Notifications](https://developers.openai.com/codex/config-advanced#notifications) — official legacy `notify` event and payload.
- [Codex App Server](https://developers.openai.com/codex/app-server) — official JSON-RPC lifecycle, thread/turn APIs, notifications, status, and resume/read controls.
- [Non-interactive mode](https://developers.openai.com/codex/noninteractive) — official JSONL event stream and `codex exec resume` contract.
- [Codex rust-v0.144.6](https://github.com/openai/codex/releases/tag/rust-v0.144.6) — official latest release at research time.
- [v0.144.6 SessionEnd hook implementation](https://github.com/openai/codex/blob/rust-v0.144.6/codex-rs/hooks/src/events/session_end.rs) — official release source for the currently under-documented teardown hook.
- [App Server protocol schemas](https://github.com/openai/codex/tree/rust-v0.144.6/codex-rs/app-server-protocol/schema) — official generated payload types.

### OpenCode

- [Plugins](https://opencode.ai/docs/plugins) — official plugin load order, event list, plugin context, and notification example.
- [Server](https://opencode.ai/docs/server) — official HTTP/SSE, session status, async prompt, and TUI control APIs.
- [SDK](https://opencode.ai/docs/sdk) — official client/session/event subscription surface.
- [CLI](https://opencode.ai/docs/cli) — official `--session`, `--continue`, `attach`, `run --attach`, and session management commands.
- [OpenCode v1.18.3](https://github.com/anomalyco/opencode/releases/tag/v1.18.3) — official latest release at research time.
- [v1.18.3 event stream implementation](https://github.com/anomalyco/opencode/blob/v1.18.3/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts) — official release source for live event IDs and non-replayable SSE framing.
- [v1.18.3 status implementation](https://github.com/anomalyco/opencode/blob/v1.18.3/packages/opencode/src/session/status.ts) — official release source for `busy`, `retry`, and `idle` publication.
- [v1.18.3 CLI transport](https://github.com/anomalyco/opencode/blob/v1.18.3/packages/opencode/src/cli/cmd/run/stream.transport.ts) — official release evidence that status events can be missed or stale and must be checked against live state.

## Hotlinks

- [Claude async hook limitations and `asyncRewake`](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)
- [Claude `Stop` payload and continuation](https://code.claude.com/docs/en/hooks#stop)
- [Claude scheduled-task limitations](https://code.claude.com/docs/en/scheduled-tasks#limitations)
- [Claude Channel delivery semantics](https://code.claude.com/docs/en/channels-reference#notification-format)
- [Codex hook runtime behavior](https://developers.openai.com/codex/hooks)
- [Codex App Server turn events](https://developers.openai.com/codex/app-server#turn-events)
- [Codex App Server status](https://developers.openai.com/codex/app-server#track-thread-status-changes)
- [OpenCode session/message APIs](https://opencode.ai/docs/server#sessions)
- [OpenCode server events](https://opencode.ai/docs/server#events)
- [OpenCode SDK event subscription](https://opencode.ai/docs/sdk#events)

## Capability Matrix

| Host surface | Meaningful signals | Identity in the supported payload | Blocking / async behavior | True background model wake? | Correctness fallback |
| --- | --- | --- | --- | --- | --- |
| Claude Code hooks | `SessionStart`, `Notification`, `SubagentStop`, `TaskCompleted`, `Stop`, `StopFailure`, `SessionEnd`; tool events are available but too noisy for Manager | `session_id`; `prompt_id` after first prompt; event-specific `agent_id`, `task_id`; transcript path is explicitly lagging | Sync hooks block by default. Command hooks may use `async`; `asyncRewake` wakes an idle session on exit `2`. Async outputs cannot control the event and firings are not deduplicated | **Yes, while the session is alive**, through `asyncRewake`; `Stop` can also continue immediately | `SessionStart(startup|resume)` plus explicit `resume/status` must reconcile durable state. Do not infer completion from `Stop` alone |
| Claude scheduled tasks | Cron fire, one-shot reminder, dynamic `/loop`, `ScheduleWakeup` | Task ID and session context; `Stop` exposes `session_crons` | Enqueued between turns, waits while busy, one-minute granularity for cron, seven-day expiry | **Yes, while a live/background session remains available** | No catch-up; restore only unexpired tasks on resume. Reconcile at every fire and every resume |
| Claude Channels (research preview) | External webhook/chat/monitor event; optional permission relay | Session is implicit in the channel subprocess connection; payload is `content` plus caller-defined string `meta` | Notifications are unacknowledged; write-to-transport is not processing confirmation; unavailable events may be silently dropped; queued events preserve order and may be grouped | **Yes, into the running session** | Sender-gate, include an external event ID in `meta`, persist upstream state, and reconcile rather than trusting delivery |
| Codex lifecycle hooks | `SessionStart`, `SubagentStop`, `Stop`; tool/prompt/compact events for lower-level instrumentation | `session_id` (thread), `turn_id` on turn-scoped hooks, `agent_id` for subagents | Matching command hooks launch concurrently. Only command handlers run. `async` handlers are skipped. `Stop` can create an immediate continuation prompt | **No delayed hook wake**; only immediate continuation at `Stop` | Full reconciliation on `SessionStart(resume)` and explicit `resume/status`; never wait for a hook that may not run |
| Codex `notify` | `agent-turn-complete` only | `thread-id`, `turn-id`, `cwd`, input messages, last assistant message | Launches an external notification program; it is a side channel, not model feedback | **No**; an external supervisor could separately invoke Codex, but that is its own dispatch | Treat as a cheap edge trigger. Persist hint, then reconcile on the next safe invocation |
| Codex App Server | `thread/started`, `thread/status/changed`, `turn/started`, `turn/completed`, `item/completed`, approval/server requests, `hook/started`, `hook/completed` | `threadId`, `turn.id`/`turnId`, item IDs; envelope may include `emittedAtMs`, not a unique event ID | Live JSON-RPC notification stream over a connected transport; status only describes loaded threads | **Yes, if an external client owns the wake**, by `thread/resume` plus `turn/start` | After reconnect use `thread/read`/`thread/resume` and persisted turn data; do not use notification receipt as canonical completion |
| Codex `exec --json` | `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*`, `error` | Thread ID appears in stream; specific session can be resumed | Process-scoped JSONL stream | **No autonomous wake**; a supervisor can run `codex exec resume <id>` | Resume by recorded ID and reconcile workflow-owned state before asking the model to act |
| OpenCode plugin events | `session.created`, `session.status`, `session.idle`, `session.error`, `session.updated`, `permission.asked`, `permission.replied`, message/tool/todo events | `sessionID`; event-specific permission/message IDs. Public plugin `Event` typing does not promise a durable cursor | Normal transform hooks run sequentially. Event callbacks are notifications; do not depend on them blocking a state transition | **Yes**, because the plugin receives an SDK client and can call the server's async prompt API | Deduplicate locally, read `/session/status`, and reconcile durable workflow state before `prompt_async` |
| OpenCode server / SDK | SSE `/event` and `/global/event`, `/session/status`, `/session/:id`, messages, `prompt_async` | Current release stream JSON includes an `evt_*` ID; status has `sessionID` and `idle|busy|retry` | Live SSE; no documented replay cursor or acknowledgement. `prompt_async` returns `204` once accepted and completion arrives later by events/state | **Yes, while the server lives**, through `prompt_async` | Poll `/session/status`, reload messages/session, and perform Manager reconciliation; the official CLI already uses this pattern |

## Key Findings

### 1. “Wake” must be split into three different capabilities

The hosts expose three behaviors that must not be collapsed into one boolean:

1. **Observe:** run a hook or receive an event when a lifecycle transition occurs.
2. **Signal:** record or forward that event outside the host without starting another model turn.
3. **React:** start or continue a model turn in the intended session.

Claude `Notification`, Codex `notify`, and OpenCode SSE all observe/signal. Claude `asyncRewake`, Claude Channels, Claude scheduled tasks, Codex App Server `turn/start`, and OpenCode `prompt_async` can react. The last two require a separate live client or supervisor to make the call; they are not self-waking hook semantics.

Manager should name these separately in its adapter contract, for example `observe`, `enqueue_hint`, and `request_turn`, and report host readiness accordingly. A host can be correct with only the first two because the hint is reconciled later.

### 2. Claude Code

#### Confirmed lifecycle events

The [Hooks reference](https://code.claude.com/docs/en/hooks#hook-lifecycle) documents a broad lifecycle. The Manager-relevant subset is:

- `SessionStart` for `startup`, `resume`, `clear`, and `compact`.
- `Notification` for `permission_prompt`, `idle_prompt`, `agent_needs_input`, and `agent_completed`; the last two require v2.1.198+ and only fire while agent view is open.
- `SubagentStop`, with the child `agent_id`, `agent_type`, child transcript path, and final assistant message.
- `TaskCompleted`, with task identity and optional teammate/team identity.
- `Stop` for a successfully completed main response, and `StopFailure` instead when an API error ends the turn. `Stop` does not fire for user interruption.
- `SessionEnd`, with a reason and a short teardown budget; it cannot block termination.

Every command hook receives `session_id`, `cwd`, `hook_event_name`, and a transcript path. `prompt_id` is available from v2.1.196 after the first user prompt. The transcript is explicitly asynchronous and may omit the newest messages, so terminal hooks must prefer event fields such as `last_assistant_message` rather than parsing the transcript.

`Stop` is not proof that an effort is done. Its payload can list `background_tasks` and `session_crons`, and its continuation guard is deliberately bounded: Claude Code overrides repeated stop blocking after eight continuations. It is a useful “turn settled” hint, not a portfolio completion fact.

#### Confirmed true wake paths

- `asyncRewake: true` implies an asynchronous command hook. If the process later exits `2`, Claude Code immediately wakes Claude even while the live session is idle, using stderr (or stdout when stderr is empty) as a system reminder. Ordinary async output waits for the next user turn. Each firing creates a separate process and the host performs no deduplication.
- Session cron and `/loop` tasks enqueue prompts between turns. They require an open session, although backgrounding the session keeps them alive. They do not replay every missed interval, and closing the process stops firing. Unexpired tasks can be restored by `--resume`/`--continue`.
- Channels push `notifications/claude/channel` into one running session. They are research preview, require explicit enablement, and have a strict security boundary. Delivery is not acknowledged; events can be dropped silently when the server is not loaded or policy blocks it. A custom Manager channel would also require an allowlist or the development bypass during the preview.

These are excellent latency optimizations for Claude, but none replaces durable reconciliation. A safe first slice can use `SessionStart`, `Stop`/`StopFailure`, relevant `Notification` events, and `asyncRewake`; Channels and scheduled tasks should remain optional capabilities rather than portability requirements.

### 3. Codex

#### Confirmed lifecycle hooks

The published [Codex Hooks](https://developers.openai.com/codex/hooks) page is explicitly the release behavior reference. It confirms `SessionStart`, `SubagentStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, and `Stop`.

Important differences from Claude:

- Matching command hooks from multiple files launch concurrently.
- Only `type: "command"` runs today; prompt and agent handlers are parsed but skipped.
- The `async` field is parsed but asynchronous handlers are not supported and are skipped.
- The default command timeout is 600 seconds, so event adapters should set a much smaller timeout.
- `session_id` is the current Codex thread ID; `turn_id` is present on turn-scoped hooks. Subagent hooks retain the parent `session_id` and add `agent_id`/`agent_type`.
- `Stop` can return `decision: "block"` or exit `2`; Codex converts the reason into a new continuation prompt. This is immediate turn continuation, not a future wake after the session becomes idle.

The v0.144.6 release source contains a `SessionEnd` command hook with `session_id`, `cwd`, transcript path, and the single reason `other`, constrained to a one-second default and three-second maximum. It is absent from the public hooks page even though that page warns that repository schemas can lead release behavior. The conservative portability contract should therefore treat Codex `SessionEnd` as **release-source-confirmed but public-contract-incomplete**, not as a mandatory Manager event.

#### `notify` is a side channel

Codex advanced configuration documents one supported `notify` event, `agent-turn-complete`. The process receives a single JSON argument with `thread-id`, `turn-id`, `cwd`, input messages, and final assistant text. The official implementation spawns the process with no stdin/stdout feedback path into the model. It is suitable for appending a Manager hint to local state, but it cannot wake the current Codex TUI by itself.

#### App Server enables an external wake owner

The App Server is materially stronger than hooks. A connected client can:

- start, resume, read, list, and subscribe to threads;
- start or steer turns;
- observe `thread/status/changed`, `turn/started`, `turn/completed`, final `item/completed`, approvals, errors, and hook execution;
- inspect stored thread history with `thread/read` without loading it;
- resume a thread and explicitly submit `turn/start`.

This supports a real Manager wake when a long-lived Manager supervisor owns the App Server connection. The notification envelope provides `emittedAtMs` in current schemas but no unique event ID, and the documented notification protocol is live-stream oriented. A reconnecting adapter must re-read thread/turn state. Thread runtime status applies only while loaded and can transition to `notLoaded` after the last subscriber leaves and the grace period expires.

For the portable first slice, App Server should be an enhanced adapter. The base Codex contract should remain `SessionStart`/`Stop` plus `notify`, with `resume/status` reconciliation providing correctness when no supervisor is present.

### 4. OpenCode

#### Plugin and server signals

OpenCode plugins receive a `client` SDK and an `event` hook. The documented Manager-relevant events include:

- `session.created`, `session.updated`, `session.compacted`, `session.status`, deprecated `session.idle`, and `session.error`;
- `permission.asked` and `permission.replied`;
- message, todo, command, file, and tool events when lower-level detail is needed.

`session.status` contains `sessionID` and one of `idle`, `busy`, or `retry`; retry includes attempt/message/next-time information in the current release schema. `session.error` associates an error with a session when available.

The server publishes live events through `/event` and directory-qualified `/global/event`. Current v1.18.3 release code puts an `evt_*` ID in each JSON event, but it does not set the SSE `id:` field and the published API exposes no replay cursor. Status events are live rather than durable. A Manager adapter can preserve an observed provider ID when present, but cannot assume that reconnecting from that ID replays anything.

#### True wake and the official fallback pattern

`POST /session/:id/prompt_async` accepts the same prompt body as the synchronous message endpoint, starts the session if needed, returns `204`, and completes later through state/events. A plugin already has the SDK client required to make this call. Therefore OpenCode can truly wake an existing session while its server remains alive.

The official CLI demonstrates why this still cannot be the source of truth. Its v1.18.3 transport says that some transports can miss `session.status` events, polls `session.status` in addition to listening, uses a turn tick to reject stale idle events, and rechecks live status before resolving a possibly delayed idle event. Manager should copy the principle, not the private implementation:

1. consume the event as a hint;
2. acquire the effort lease and ensure the event belongs to the current generation;
3. call the status/state APIs;
4. reconcile Manager/workflow state;
5. only then decide whether `prompt_async` is warranted.

## API / CLI / Config Details

### Recommended meaningful-event vocabulary

The next Ticket can map host names into a small semantic vocabulary without pretending payload parity:

| Manager semantic kind | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| `session.resumed` | `SessionStart` with `source=resume` | `SessionStart` with `source=resume`; App Server `thread/resume` response | Explicit `--session`/`--continue`; no equivalent mandatory plugin startup event, so invocation itself triggers reconcile |
| `turn.settled` | `Stop` | `Stop`; `notify: agent-turn-complete`; App Server `turn/completed` | `session.status` with `idle` after recheck |
| `turn.failed` | `StopFailure` | App Server `turn/completed` with `failed`; JSONL `turn.failed` | `session.error`, or status `retry` as non-terminal |
| `child.settled` | `SubagentStop`, `TaskCompleted`, `Notification: agent_completed` | `SubagentStop`; App Server final collab/item events | Child-session status/message events where a child session is used |
| `attention.required` | `Notification: permission_prompt|agent_needs_input` | App Server approval requests and active `waitingOnApproval` status | `permission.asked`, status `retry`, `session.error` |
| `session.ended` | `SessionEnd` | Optional release-source-only `SessionEnd`; otherwise process/App Server lifecycle | Server/process lifecycle or explicit invocation; no documented plugin event equivalent |

Tool-level events should not wake Manager by default. They are high-volume and normally describe implementation mechanics owned by the worker. The adapter should subscribe only when a workflow lacks a higher-level completion/failure signal.

### Minimal normalized fields suggested by the evidence

This report does not decide the final schema, but the host evidence requires at least:

- host and adapter version;
- normalized semantic kind and original event name;
- Manager effort ID when the adapter can resolve it;
- host session/thread ID;
- host turn/prompt ID when present;
- child/task/item/permission ID when present;
- provider event ID when present;
- observed timestamp, plus provider-emitted timestamp when present;
- source generation/lease epoch;
- a payload digest and bounded, non-instructional metadata;
- delivery class (`best_effort_live`, `reconciled_snapshot`, or later a durable source class);
- processing disposition (`seen`, `duplicate`, `stale_generation`, `reconciled`, `wake_requested`, `deferred`).

No host supplies all these fields. A Manager-owned ingestion ID is necessary, but it must not be mistaken for upstream exactly-once delivery.

### Deterministic fallback by host

- **Claude Code:** on `SessionStart(startup|resume)` and every explicit Manager invocation, load the portfolio, audit the effort lease/generation, query workflow-owned state, and rebuild the brief. `claude --resume <session-id>`/`--continue` restores conversation context, but the portfolio and tracker remain the state authority. Background agent inventory can be inspected with `claude agents --json`; absence from a live list is not delivery evidence.
- **Codex:** on `SessionStart(resume)`, `codex exec resume <SESSION_ID>`, or App Server reconnect, read the stored thread/turn state and then reconcile workflow-owned state. `thread/status/changed` is only a runtime hint for loaded threads. A missed `notify` must never strand work.
- **OpenCode:** on `opencode --session`, `opencode run --session`, server reconnect, and every Manager `resume/status`, read `/session/status` and relevant session/messages, then reconcile workflow-owned state. Treat `session.idle` as valid only after a current status read and generation check.

## Version Notes

- Research snapshot: 2026-07-19.
- Claude Code latest official release observed: `v2.1.215`, published 2026-07-19. `prompt_id` requires v2.1.196+, `agent_needs_input`/`agent_completed` require v2.1.198+, and async hook malformed-output handling changed in v2.1.202.
- Codex latest official release observed: `rust-v0.144.6`, published 2026-07-18. The official Hooks page is the release behavior reference; it explicitly warns that `main` schemas may contain unreleased fields. This report uses the release tag when discussing the under-documented `SessionEnd` implementation.
- OpenCode latest official release observed: `v1.18.3`, published 2026-07-16. The event-ID, status, async-prompt, and CLI fallback findings were checked against that tag, not only the moving `dev` branch.
- Host capabilities are moving quickly. Adapters need capability detection and version-gated smokes rather than assuming one global minimum host version.

## Gotchas

1. **A completed turn is not completed Manager work.** It may precede background tasks, a PR landing, HITL, or workflow feedback.
2. **A live event is not durable delivery.** Claude Channels can drop silently; OpenCode SSE has no documented replay cursor; Codex App Server notifications are connection-scoped.
3. **A process callback is not a model wake.** Codex `notify` is the clearest example.
4. **A wake is not authority.** External content must not broaden intent, alter scope, or dispatch work. It only causes reconciliation.
5. **Idle is race-prone.** OpenCode's own client guards against missed and stale idle signals. The same generation check is required across all hosts.
6. **Deduplication is Manager-owned.** Claude async hooks explicitly have no deduplication; the other public transports do not promise exactly-once processing.
7. **Session identity is host-local.** It must be mapped to a Manager effort ID; never infer effort identity from cwd alone.
8. **Teardown hooks have small budgets.** Claude `SessionEnd` defaults to 1.5 seconds; Codex's release implementation is capped at three seconds. They can enqueue a tiny hint, not perform network-heavy reconciliation.
9. **Preview features cannot define baseline correctness.** Claude Channels are useful but research preview and policy/allowlist gated.
10. **Do not build a hidden second scheduler.** Claude scheduled tasks, Codex App Server, and OpenCode server may accelerate supervision, but durable coordination remains in Manager and workflow-owned artifacts.

## Open Questions

- Which host capabilities are mandatory for the first supported version matrix, and which are opportunistic enhancements?
- Should Claude `asyncRewake` be enabled directly, or should the hook only enqueue and let an existing RedSkills event runtime decide whether the current effort lease may be awakened?
- Will the Codex adapter own an App Server connection, or begin with lifecycle hooks plus `notify` and add App Server wake later?
- Should the OpenCode adapter use a project plugin, an external server client, or both? The plugin is easy to install, while an external client gives a clearer lease boundary.
- What bounded payload fields are safe to persist without storing prompts, assistant output, logs, diffs, or untrusted Issue/Channel text?
- What capability/version smoke proves that each configured event really fires on Claude Code, Codex, and OpenCode without relying on documentation alone?

## Source-by-Source Notes

### Claude hooks and sessions

The hooks reference supplies the strongest direct wake primitive (`asyncRewake`) and explicitly denies exactly-once behavior. Its `SessionStart`, `Stop`, `StopFailure`, `Notification`, `SubagentStop`, `TaskCompleted`, and `SessionEnd` schemas are sufficient for a useful adapter without transcript parsing. The CLI/headless docs provide stable session IDs and resume triggers for the deterministic fallback.

### Claude scheduled tasks and Channels

Scheduled tasks are a bounded in-session scheduler, not durable cross-host orchestration. Channels are an event push bridge, not a durable queue. Both are valuable optional latency paths; neither should be required to reach a correct Manager brief after restart.

### Codex hooks, notify, and App Server

Codex hooks give portable synchronous lifecycle interception and immediate Stop continuation. `notify` gives a cheap non-blocking side effect. App Server gives the complete observe-and-react architecture, including explicit thread resume and turn start. The capability tiers should remain visible rather than being flattened into “Codex supports wake.”

### OpenCode plugins, server, and release source

The public plugin/server/SDK docs establish the supported integration shape. The v1.18.3 source adds the crucial negative guarantee: even the official client does not trust live status events alone. That implementation evidence directly supports Manager's event-hint plus reconciliation architecture.

## Recommended Next Steps

1. In **Define the three-host Manager event and wake contract**, adopt a host-neutral semantic event vocabulary and mark every host event `best_effort` until reconciliation succeeds.
2. Require adapters to implement `reconcile()`; make `requestWake()` optional and capability-gated.
3. Define deduplication around Manager effort ID, lease generation, host session ID, host turn/task identity, normalized kind, terminal status, and provider event ID when available. Reconciliation must be idempotent even when the same hint is accepted twice.
4. Use these first-slice wake candidates:
   - Claude: `SessionStart`, `Stop`, `StopFailure`, relevant `Notification`, `SubagentStop`, and optional `asyncRewake`.
   - Codex: `SessionStart`, `Stop`, `SubagentStop`, `notify`; App Server events/wake behind a capability flag.
   - OpenCode: `session.status`, `session.error`, `permission.asked`, plus `/session/status` and `prompt_async` behind the lease/recheck gate.
5. Specify an exact degradation rule: unsupported or failed wake appends a bounded local hint and waits for the next `manager resume/status` or host SessionStart; it never changes the durable effort state by itself.
6. Add host contract smokes that simulate duplicate, missing, delayed, and out-of-order hints and prove that full resume/status reconciliation converges to the same brief.
