# WorkItem abstraction decouples the worker engine from the GitHub issue tracker

## Status

Accepted. Implements Track D (the dispatch headline) of PRD #928 / PRD #907. Records the structured decision to route every worker iteration through a tracker-agnostic `WorkItem` so an ad-hoc objective string is a first-class unit of work. Design only — implementation is tracked in subsequent `/go` slices. Maintainer approved the WorkItem boundary (throwaway record), the backend seam (minimal interface), and the engine-sharing strategy (unified `processWorkItem`) on 2026-07-01.

## Context

The AFK engine's single entry point is `processIssue(issue: number)`. That signature is the coupling: it demands a GitHub issue number before any development can begin, and the lifecycle it drives — claim, label, comment, close — is hardwired to GitHub API calls. The consequence is a hard architectural rule: **everything must be an issue before any dev starts.**

This blocks the `/go` middle tier (ADR 0081, PRD #928). `/go "<demand>"` dispatches a *concrete, single demand* without the maintainer authoring a PRD or triaging issues. It reuses the entire AFK engine — worker, supervisor-of-one, slot manager, circuit breaker, reaper, worktree, heartbeat, envelope, reconcile — but it has no pre-existing issue number to pass to `processIssue`. Today the only way to feed the engine an objective that is not already a tracked issue is the `--reconcile-issue` alternate entry, which is a narrow no-agent landing path (ADR 0055), not a general dispatch seam.

There are two coupling problems, not one:

1. **Entry-point coupling.** `processIssue(issue: number)` accepts only a GitHub identifier. An objective string has no home.
2. **Lifecycle coupling.** Even if an objective could enter, the claim/label/comment/close steps call GitHub directly, so there is no seam at which a different tracker — or a disposable record — could be substituted.

Prior art inside the engine already proves the shape is separable: `--reconcile-issue` is an alternate engine entry that runs the same supervisor/slot/circuit/reaper substrate over a different lifecycle. The engine substrate is tracker-neutral in practice; only the entry signature and the lifecycle calls assume GitHub.

## Decision

### 1. Introduce a `WorkItem` abstraction with an injectable `WorkItemBackend`

Decouple the engine from any specific tracker by naming the unit of work `WorkItem` and putting every tracker-touching operation behind an injected `WorkItemBackend`. The engine holds a `WorkItem`; it never calls GitHub directly. The backend is the only component that knows what a tracker is.

### 2. WorkItem boundary — throwaway tracking record, not issueless

An ad-hoc objective is realised as a **throwaway tracking record**: a disposable GitHub issue created at claim time and closed (or deleted) at completion. This is deliberately consistent with the `/go` middle-tier "disposable issue" pattern already locked in PRD #928 and ADR 0081 — `/go` mints a disposable tracking issue in an isolated lane (out of `ready-for-agent`, so a running fleet can never claim it), does the work, and the record auto-closes on merge.

**Purely issueless operation (no GH record at all) is explicitly out of scope for this ADR.** The throwaway record is the boundary because it buys three things at near-zero cost: an audit trail (every objective has a URL and a comment thread), reuse of the existing claim/label/comment/close plumbing, and a merge target the existing `doLanding` path already understands. A fully issueless mode would require the engine to carry lifecycle state with no external anchor; that is a larger decision deferred to a future ADR.

### 3. `WorkItemBackend` interface — minimal, no full GH parity

The seam is intentionally small. It carries only the five operations the engine's lifecycle actually invokes; it does not attempt to mirror the GitHub Issues API.

```typescript
// A tracker-neutral description of the work to do.
interface WorkItemSpec {
  title: string;
  body: string;          // objective text / issue body
  labels?: string[];
}

// An opaque handle to a claimed record. Backend-defined contents
// (e.g. a GitHub issue number for both concrete backends today).
interface WorkItemHandle {
  id: string;
}

// The outcome the engine reports when it finishes with a handle.
type Outcome =
  | { kind: "merged"; pr: number }
  | { kind: "blocked"; reason: string }
  | { kind: "abandoned"; reason: string };

interface WorkItemBackend {
  claim(spec: WorkItemSpec): Promise<WorkItemHandle>;
  release(handle: WorkItemHandle): Promise<void>;
  close(handle: WorkItemHandle, outcome: Outcome): Promise<void>;
  comment(handle: WorkItemHandle, body: string): Promise<void>;
  getSpec(handle: WorkItemHandle): Promise<WorkItemSpec>;
}
```

- **`claim`** takes a spec and returns a handle. For GitHub this adopts the existing issue (atomic claim-comment reconciler, ADR 0066); for the ad-hoc case it *creates* the disposable record and returns its handle.
- **`release`** relinquishes a claim without a terminal verdict (e.g. the worker aborts and the record returns to the pool or is torn down).
- **`close`** applies the terminal outcome — merged / blocked / abandoned — mapping it to the tracker's own vocabulary (labels, close state, deletion for the throwaway record).
- **`comment`** posts progress/blocker/envelope text to the record's thread.
- **`getSpec`** rehydrates the objective from a handle, so a worker resuming on a handle can recover the work description without the caller threading it.

No `list`, no `search`, no `assign`, no reaction/label-diff surface — those stay inside the concrete backend where the fleet's queue scanner already lives. The engine only ever holds one `WorkItem` at a time; enumeration is a scheduler concern, not an engine-lifecycle concern, so it is not on the seam.

### 4. Engine sharing — unified `processWorkItem(item: WorkItem)`

Introduce `processWorkItem(item: WorkItem)` as the single engine entry point. A `WorkItem` bundles a `WorkItemHandle` with its `WorkItemBackend`, so the engine can drive the full lifecycle (claim already done → run agent → comment → close) through the injected backend without knowing the tracker.

Both dispatch sources converge on it:

- **`/afk`** wraps each GitHub issue as a **`GithubWorkItem`** — a `WorkItem` whose backend is the existing GitHub backend and whose handle is the real issue number. This is the existing behaviour with **zero regression**: the same claim, the same labels, the same close, the same comment thread.
- **`/go`** creates an **`AdHocWorkItem`** — a `WorkItem` whose backend creates a throwaway disposable issue at `claim` time and closes/deletes it at `close` time. The objective string is the `WorkItemSpec.body`.

Both share the **same supervisor, slot manager, circuit breaker, and reaper substrate, unchanged.** The substrate never learns there are two kinds of work item; it schedules `WorkItem`s and calls `processWorkItem`.

### 5. Migration path — `processIssue` becomes a thin wrapper

`processIssue(issue: number)` is preserved as a **thin wrapper** that constructs a `GithubWorkItem` from the issue number and delegates to `processWorkItem`. Every existing `/afk` call site keeps calling `processIssue`; the wrapper is a pure adapter with no behaviour change. This makes the change additive — the new seam is introduced *beneath* the current entry point, not in place of it.

The `--reconcile-issue` no-agent landing entry (ADR 0055) is unaffected: it already runs a distinct, agent-less lifecycle and continues to do so. The `WorkItem` abstraction generalises the *agent-running* entry (`processIssue`), not the reconcile entry.

## Consequences

- **`/go` reuses the engine without duplication.** The ad-hoc middle tier gets the full supervisor/slot/circuit/reaper substrate by supplying an `AdHocWorkItem`, not by forking a parallel engine. This is the concrete unblock this ADR exists to deliver.
- **Throwaway issues are the audit trail.** Every ad-hoc objective leaves a URL, a claim comment, an outcome, and a close event — the same observability `/afk` issues already have, for free.
- **The backend is swappable.** A future non-GitHub tracker (or a purely-in-memory record for testing) implements the five-method `WorkItemBackend` and drops in. The engine does not change. This is the payoff of decoupling the entry point from the tracker.
- **No breaking change.** `processIssue` stays, the fleet keeps scanning GitHub, and existing `/afk` flows are byte-for-byte identical because `GithubWorkItem` wraps the current backend. The regression surface is the wrapper adapter only.
- **The seam stays honest by staying small.** Five methods with no GH-parity ambition means the interface will not accrete tracker-specific bulge; enumeration/scheduling deliberately live outside it, in the concrete backend.
- **Issueless operation remains a future decision.** By fixing the boundary at the throwaway record, this ADR does not commit the engine to lifecycle-with-no-external-anchor; that trade-off is deferred, not foreclosed.

## Related

- ADR 0081 — command topology (`/goal`→`/go`→`/afk`); defines the `/go` middle tier, the disposable-issue lane, and the `origin` field this ADR's dispatch sources set.
- ADR 0055 / 0056 — the `--reconcile-issue` no-agent landing entry: prior art that the engine substrate is separable from the GitHub entry signature; unaffected by this ADR (it generalises the agent-running entry only).
- ADR 0066 — the atomic GitHub-native claim reconciler that the `GithubWorkItem` backend's `claim` reuses.
- ADR 0030 / 0031 — the `doLanding` path; the throwaway record's merge target is understood by the existing landing logic unchanged.
- PRD #928 — the dispatch architecture (`/go` implementation, disposable issue, worktree manager, `origin` field).
- PRD #907 — the parent program (Track D — dispatch).
- Issue #912 — this ADR.

## Notes

- **`WorkItem` vs `WorkItemSpec` vs `WorkItemHandle`.** The *spec* is the tracker-neutral description of the work (title/body/labels). The *handle* is an opaque, backend-defined pointer to a claimed record. The *WorkItem* is the runtime pairing of a handle with its backend that the engine drives. Keeping the three distinct is what lets `getSpec(handle)` rehydrate an objective without the caller threading the description.
- **No source-repo names** in the ADR or committed content. The absorbed dispatch-decoupling concept retains its origin in the PRD #928 grilling session, not in naming.
