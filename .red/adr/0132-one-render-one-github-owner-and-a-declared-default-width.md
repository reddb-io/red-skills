# 0132 — One render, one GitHub owner, and a declared default width

- **Status**: accepted
- **Date**: 2026-08-02
- **Related**: ADR 0084 (surfaces read from cache, never fetch in a render path), ADR 0091 (the canonical `npx -y -p` invocation), ADR 0130 (`redskilled` is the host-scoped execution daemon — rules 3, 9 and 10, and the one-token GitHub decision), ADR 0131 (the herdr plugin is vendored here), issues #3079 (the display record nobody publishes), #3080 (memory accounting blind by 377×), #3081 (the launch env that never arrives), #3092 (a live daemon reported as absent)

## Context

Three complaints arrived together, and they turned out to be one shape.

**The statusline got poorer, not richer.** ADR 0130 rule 10 moved rendering to the daemon so that "the string a pure function of the payload" would keep surfaces from drifting. What the daemon actually renders is `reddb-io/red-skills 2w 14.4M v3.3.9`, while the format the skill documents carries runner, model, effort, phase, elapsed, diffstat, tokens and vitals. Nothing regressed by accident: rule 3 forbids the daemon castle semantics, and a single rendered string cannot serve a one-line statusline and a full TUI at once. The impoverished line is the designed consequence of the two rules meeting.

**The GitHub quota kept hitting zero.** Twice in one hour, GraphQL went to `0/5000` while REST sat untouched at `4891/5000`. The cause is not a greedy consumer; it is that `ghReadSurface` (`apps/dev/src/runtime/gh/read.ts:107-114`) classifies *every* `--json` listing and view as GraphQL and uses that knowledge only to label failures. The hot path — `issue view`, `pr view`, polled per Worker per iteration — is single-object reads issued against the surface budgeted by node points, which is the worst possible use of it and the best possible use of the one sitting idle.

**Nobody could say how many Workers we run by default.** The MCP `project_start` schema advertises `target` default `2`. `.red/config.yaml` declares nothing. The skill's CONFIG.md documents no width at all and mentions "width-2 fleets" only in passing. The maintainer's intent was `1`. ADR 0130 names `defaultFleetWidth` as a host-scoped admission parameter and never gives it a value.

Underneath all three sits a pattern this repo has now hit five times: **a mechanism designed on both sides and wired on one.** `publishRedskilledWorkerLogLine` has zero callers (#3079). `RedskilledWorkerDisplay` is fully typed and never populated. The launch template's `env` never reaches the process (#3081). The session lease's `renew()` has zero callers, so `renewed_at` never advances (#3092). Each read as healthy silence.

## Decision

**1. The no-drift guarantee is one implementation, not one string.** A render module outside the daemon draws a payload at parameterized densities — statusline line, host panel, full dashboard. It is stateless and owns no transport: a pure function from one decoded payload to one drawn surface, so the same module serves a socket read, a piped file and a fixture. It accepts JSON, JSONL, TOON and TOONL inbound, matching the decoder that already sniffs JSON-or-TOON; the repo's TOON mandate governs writers and is unchanged. This amends rule 10's letter to serve its intent: four surfaces at four densities cannot share a string, and they must not each own a layout.

**2. The daemon composes; the skeleton is always served and the extras are asked for.** Workers, projects and budget travel on every response — rule 9 already entitles a session to see the whole machine, so withholding them only buys a second round trip. What scales with Worker count — the `--verbose` last-log lines, per-Worker vitals — travels on request. The degradation ladder (workers → projects → host) is layout and moves to the render module with the rest.

**3. ETA is computed by the project.** Neither other party can: the render is stateless and cannot accumulate history; the daemon is forbidden the semantics to know what a phase is. It travels as an opaque field on the display record, exactly as a count does. Honest ETA requires per-phase duration instrumentation, which does not exist today — `history.toonl` records `duration_s` per issue-level event only. **A linear extrapolation from `phase_index/phase_total` is refused**: it moves with the progress bar, so it looks precise while being systematically wrong, and a dashboard that lies about one number loses the reader for all of them.

**4. `packages/github` owns the API-surface decision, and the principle is cardinality.** A single-object read goes to REST; a multi-node listing or multi-repository aggregate goes to GraphQL. Cardinality is decidable statically and never changes for an operation, unlike a frequency or budget-symmetry policy that needs telemetry and answers differently each release. The static split is the default and a second implementation is built only for operations that actually exhaust. `ghReadSurface` becomes the router it already almost is.

**5. The quota ledger belongs to the daemon.** It already holds the token and is already the machine's only host-scoped singleton. A budget is per token, so a per-process view of it is the same blindness that makes per-process RSS sampling miss a cgroup's real total (#3080). A remaining-points integer is stored without interpretation, so this stays inside rule 3's frontier rather than widening it.

**6. Semi-offline is a circuit breaker that dams every write except the claim.** When the combined budget is spent the breaker opens, reads fall back to prefetched state, and writes queue durably for replay. Claiming is a three-layer scheme — local `mkdir` lock, GitHub label pre-check, stale-lock boot sweep — and damming the middle layer leaves only a host-local lock: safe on one machine, two Workers on one branch the moment a second host drains the same backlog. Every other write is narrative, and a late progress comment costs nothing. **Prefetch is chosen by the project and executed by the daemon**, because selecting issues by chained or similar dependencies means reading `req:N` and `blocked:dependency` — castle semantics the daemon may not carry. A body it stores is opaque; a dependency graph it reasons over is not.

**7. The default fleet width is one, declared in one place, and asserted equal across surfaces.** A project declares `plugins.dev.afk.target`; the daemon's `defaultFleetWidth` is the host-scoped ceiling above it. A test fails when the MCP schema, the CLI and the configuration documentation announce different numbers. Three defaults that disagree are what produced the question, and the equality is the decision — the value is merely its instance.

**8. `dashboard` keeps naming the project view.** The host view is `redskilled dashboard`, in the binary that owns the data, reached the ADR 0091 way. Renaming the existing `dashboard` would churn `/afk dashboard`, `daily-review`, `weekly-review` and their documentation to gain one word.

**9. The MCP is the product surface; the host command keeps the socket.** Agents and UIs consume the statusline through the MCP tool; the command-backed host reads the daemon socket directly. Both pass through the same composer and the same render, so "they cannot drift" now rests on shared code rather than on a shared string. A `statusLine` entry is a shell command, not an MCP client — routing it through MCP would mean a handshake per tick and a blank line whenever the server is not up, which is the hardest failure mode to diagnose we have.

## Consequences

- `plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md` currently forbids what decision 9 permits and must be rewritten; its blank-statusline guidance is also wrong about the most common cause (#3075).
- Per-phase duration instrumentation is new work that decision 3 depends on; until it exists there is no ETA, by decision rather than by omission.
- The display record gains `context`, `started_at` and `eta`; `runner`, `model`, `effort`, `phase`, `step`, `phase_index`, `phase_total`, `tokens`, `tools`, `added` and `removed` already exist in `worker-display.ts` and only need a publisher (#3079).
- `packages/github` couples the daemon to a package the castle also imports. Rule 3's skew-dissolving property was bought by having no shared code at all; this spends a little of it deliberately, on a module carrying GitHub API shape rather than castle semantics.
- The ADR 0130 decision that the daemon fetches every project's counts in one aliased query is **decided and unbuilt** — the herdr dashboard still reports "the daemon polls no repository". Decisions 4 and 5 assume it lands.
- Five one-sided wirings are now known (#3079, #3081, #3092 and the two above). Each shipped because an exported symbol with no callers reads exactly like a symbol that is simply unused. Tests that fail when a publisher loses its last caller are cheap and belong with each fix.

## Amendment 1 — the daemon executes every GitHub call; the Worker keeps git

Decision 4 chose a shared `packages/github` imported by both the daemon and the castle: one routing table, two callers. The alternative considered and rejected at the time was that the castle stop calling GitHub at all and reach it through the daemon. **That alternative is now the decision.**

What changed is not the argument but the scope of the ask. Decision 5 had already put the quota ledger on the daemon, and a ledger that counts only its own holder's calls is the same per-process blindness it was created to end — the castle calling GitHub directly meant the ledger was born incomplete, exactly as per-process RSS sampling misses a cgroup's real total (#3080). One owner of the token that is not the only caller of the API is half an owner.

**The daemon executes; the project decides and interprets.** That line is what keeps rule 3 intact, and it is the same line ADR 0130 already drew for the selector — *"the query that names this project's work. Carried, never read."* The project hands over a query, a target, a body of text; the daemon performs the call and returns bytes. It learns no label vocabulary, no selector semantics, no envelope format, no notion of what a Spec is. Those differ per bundle version, and a daemon that knew them would reintroduce the skew rule 3 dissolves.

| | Daemon | Project / Worker |
| --- | --- | --- |
| Token, cache, quota ledger, circuit breaker | ✅ | — |
| **Executing** the call, returning bytes | ✅ | — |
| Choosing WHICH issue to fetch | — | ✅ |
| **Composing** a comment's text | — | ✅ |
| Interpreting a label, a selector, an envelope | — | ✅ |
| `git` commit and push | — | ✅ |

**git stays with the Worker, and the GitHub API moves to the daemon.** The split is not arbitrary: `git` runs over SSH and spends no API quota, so the resource that must be owned host-wide is exactly the resource that moves. A Worker still commits, branches and pushes its own work.

`packages/github` survives with a smaller job. It is no longer a table two processes consult; it is the daemon's own routing, and the castle's side becomes a client of the socket. Decision 4's cardinality principle is unchanged — it decides which API the daemon reaches for.

**The cost, stated so it is not discovered later: fail-closed now covers reading.** ADR 0130 rule 6 means no daemon, no Worker; after this it also means no daemon, no issue read. A Worker that could previously answer "what does this ticket say" from its own `gh` call now cannot. That is a real widening of the unavailability surface, accepted because a token nobody accounts for is what spent three hours of this machine's quota in one afternoon.

## Amendment 2 — ask the authoritative source; `packages/github` is a budget-aware client, not a router

Decision 5 put the quota ledger on the daemon and described it as a total the daemon accumulates. **That ledger would have been born blind**, and the reason is worth stating plainly because it is the third instance of one mistake.

The daemon is host-scoped by construction — one per machine, and ADR 0130 deliberately extinguished the cross-host federated view. GitHub's quota is per **token**, therefore cross-host. An operator running four machines on one token would have four daemons each counting its own calls and each reporting three quarters of a fiction: "I have spent 2000 of 5000" while the token was already at zero. Measured today at the moment three of four machines were switched off, which is the only reason the numbers looked sane.

**The fix is not federation. It is to stop counting and start asking.** `GET /rate_limit` returns the true remaining budget for the whole token across every machine, and it **costs nothing**: measured here, six consecutive calls moved `core` by zero. The daemon does not need to know the operator's other machines exist — it sees their effect in the balance.

This generalizes into the rule these three defects share:

> **When an authoritative source exists, ask it. Derive only when none exists, and say that you are deriving.**

`#3080` derived host memory from a per-process RSS walk while the cgroup held the exact number: wrong by 377×. `#3092` derived "the daemon is absent" from its own failed reach while the process was alive and listening. A locally-accumulated quota ledger would have derived a token's balance from one host's share. Each read as a fact about the world and was a fact about the observer's scope.

### What `packages/github` owns

It is not a routing table. It is the one budget-aware client every GitHub call goes through, and it owns four things:

1. **Surface routing by cardinality** (decision 4, unchanged): single-object read → REST, multi-node listing or multi-repository aggregate → GraphQL. The two pools are separately budgeted, and today's measurement is the argument — two healthy Workers spent 2200 GraphQL points/hour while `core` sat at `5000/5000`, **completely untouched**. Half the account's available budget was reachable and unused.
2. **One aliased query spanning every registered repository**, which ADR 0130 already decided and nothing built. Cost becomes flat in the number of projects rather than linear — in *requests*; the GraphQL pool is budgeted in node points, so an aliased query that returns many nodes is cheaper in requests and not free in points, and the two must not be conflated.
3. **A cache with the age attached.** Counts, issue bodies and PR states are read far more often than they change. The cached value travels with its own staleness, as everything else in this system does, so a consumer renders age rather than presenting a stale count as current.
4. **An adaptive balance poll.** Because asking is free, the cadence is a function of the balance rather than a constant: rare above half, tightening as the balance falls, continuous once spent — the only event that then matters is the reset. A fixed cadence forces a choice between being slow at the edge and wasting polls in the middle; an adaptive one does not choose. **One poller, the daemon's, never a check before each call**: that would double the request count and put a synchronous round trip in every hot path, which is ADR 0084's lesson paid twice.

### Degradation becomes graduated

With an authoritative balance in hand, decision 6's breaker stops being reactive. A reserved band — a stated fraction of the budget — is kept for operations that must not fail: the claim, a landing, the closing comment of a Worker that has finished. Convenience reads are refused when the balance enters that band, while essential work continues.

So "semi-offline" is no longer a mode entered by discovering a 403. It is a posture entered deliberately, at a threshold an operator can see, with the cheap things degrading first.

**A caveat, stated rather than assumed:** `GET /rate_limit` is free of *primary* quota. GitHub also enforces secondary limits on request rate and concurrency that apply to every endpoint. The adaptive cadence must stay a cadence — seconds, not a poll per operation — and that ceiling was deliberately not probed here.

## Amendment 3 — cold single-object bursts are a newly observed cardinality

Decision 4 remains the preferred route for an individual operation: one issue or
pull request goes to REST. It must not be read as requiring k concurrent
single-object reads to become k requests. Once same-kind cold reads coexist at
the resident boundary, the client can observe a plural operation that no
individual caller could name and issue one aliased GraphQL query for it.

The change in surface belongs to the coalesced operation, not to a lone read.
The group moves only when its count exceeds a threshold derived from the
authoritative REST and GraphQL headroom; an unknown balance diverts nothing, and
the threshold never falls below one. A read with a held ETag does not enter the
group at all, because replacing a possible zero-cost `304` with a charged node
would undo Amendment 2's largest saving.

The economics stay explicit. Aliasing makes k objects flat in HTTP requests and
not in GraphQL points. The query asks `rateLimit.cost`, and attribution preserves
that returned total across the logical reads rather than pretending that one
request cost one point. This amendment records Spec #3202's counter-rule and its
implementation Ticket #3210; it does not turn the balance into a replacement for
cardinality.

The `rsp` resident introduced by #3311 is a declared execution owner rather than
a caller through `redskilled`: proxied reads keep their cache, routing and spend
lane there without daemon coupling. It therefore asks the same authoritative
balance at the same adaptive package-owned cadence. “One poller” means one per
declared execution owner, never one ask per operation; an unanswered ask still
diverts nothing.
