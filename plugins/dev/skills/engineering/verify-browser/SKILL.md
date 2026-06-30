---
name: verify-browser
description: Adversarial browser verification — confirm a UI claim against a fresh accessibility-tree snapshot before reporting success, never against memory or a pre-action snapshot. Wraps chrome-devtools-axi for token-efficient a11y-tree snapshots with numbered refs, stale-ref validation, combined navigate+capture ops, a persistent bridge, and TOON output. Use when verifying a frontend change in a real browser, confirming a fix renders, driving the browser leg of /verify, or grounding a /code-review claim about UI behavior.
---

# Verify Browser

**Never report a UI claim true until a fresh snapshot taken *after* the action proves it — your memory of the page is not evidence.** This is the absorbed discipline: claim → fresh ground-truth → confirm. Browser automation is only the vehicle; the loop is the skill, and it transfers to any adversarial pass (see `<supporting-info>`).

<what-to-do>

Run the **claim → fresh-ground-truth → confirm** loop for every browser check. Each state-changing action invalidates everything you knew about the page; treat a stale belief as a hallucination waiting to be reported as success.

### 1 — State the claim first

Before you touch the browser, write the **expected post-state** as a concrete, snapshot-checkable assertion: which element, which text, which attribute, which count. "The form should submit" is not checkable. "After clicking `submit [ref=12]`, a node with role `alert` and text containing `Saved` appears, and `email [ref=7]` is gone" is. A claim you cannot phrase against a snapshot is a claim you cannot verify — sharpen it or stop.

### 2 — Snapshot, then act on a ref

Take an a11y-tree snapshot, read the **numbered refs**, and drive actions by ref — never by guessed selectors. Use the combined navigate+capture op so you land and snapshot in one round-trip. The snapshot is your *only* source of truth about what is on the page right now.

### 3 — Re-snapshot after every state-changing action

Any click, type, navigation, or wait **invalidates the prior snapshot**. Do not reuse old refs and do not reason from what you "expect" the action did. Take a **fresh** snapshot. If chrome-devtools-axi reports a **stale ref**, that is the signal the DOM moved under you — re-snapshot and re-resolve before continuing; never retry the stale ref blind.

### 4 — Confirm the claim against the fresh snapshot

Match step 1's assertion against the **post-action** snapshot, element by element. Report success **only** when the fresh ground-truth contains exactly what you predicted. ✅ "Confirmed against snapshot taken after the click: `alert` node present, text `Saved`." ❌ "Looks like it worked" / "the click should have submitted it" / confirming from the pre-action snapshot.

### 5 — On mismatch, report the snapshot, not a guess

If the fresh snapshot does not match the claim, the change is **not verified** — say so, and quote the relevant snapshot lines as evidence. Do not soften, do not assume a timing fluke without re-snapshotting after an explicit wait, and do not paper over it. A failed verification reported honestly is the skill working; a hallucinated success is the failure mode this skill exists to kill.

### Hard rules

- ✅ One fresh snapshot per state-changing action, taken **after** it settles.
- ✅ Drive by numbered ref from the current snapshot; re-resolve on any stale-ref signal.
- ✅ Phrase every claim so it is checkable against a snapshot before acting.
- ❌ Never confirm from memory, from the pre-action snapshot, or from "what the action should have done".
- ❌ Never report success on a partial or stale match — re-snapshot instead.

</what-to-do>

<supporting-info>

### Why chrome-devtools-axi (the vehicle)

`chrome-devtools-axi` is a token-efficient layer over chrome-devtools-mcp. It exists so the verification loop above is cheap enough to run on every check rather than skipped under token pressure:

- **a11y-tree snapshots with numbered refs** — a structured accessibility tree (roles, names, states) instead of raw DOM or screenshots, with stable per-node `[ref=N]` handles to act on.
- **stale-ref validation** — refs are validated against the live tree; acting on a ref from a snapshot the DOM has since invalidated returns a stale-ref signal instead of silently targeting the wrong node. This is the mechanism that *enforces* step 3.
- **combined navigate+capture+suggest ops** — one op navigates and returns the snapshot (and can suggest the likely next action), collapsing the usual navigate → wait → snapshot round-trips.
- **persistent bridge** — the browser session is held across ops, so a multi-step claim (load → fill → submit → confirm) does not pay reconnect cost per step.
- **TOON output** — snapshots and results serialize as TOON (Token-Oriented Object Notation), ~57% fewer tokens than the raw chrome-devtools-mcp JSON for the same tree. Prefer TOON output for every op; fall back to verbose JSON only when debugging the bridge itself.

Consult the tool's own op list for exact op names and arguments; this skill governs *how* you use them, not their signatures.

### The transferable discipline (the skill)

The browser is one ground-truth source. The **claim → fresh-ground-truth → confirm** loop is the anti-hallucination pattern, and it generalizes — apply the same five steps with a different evidence source:

| Adversarial pass | Claim | Fresh ground-truth | Confirm against |
| ---------------- | ----- | ------------------ | --------------- |
| `/verify` (UI leg) | "the change renders / behaves as specified" | post-action a11y-tree snapshot | this skill |
| `/verify` (CLI/API leg) | "the command now succeeds" | a fresh run *after* the edit, not the run you remember | captured stdout/exit code |
| `/code-review` | "this line causes / fixes behavior X" | re-read the current file + run the relevant check | the actual code and check output, not the diff alone |

The failure mode is identical everywhere: reporting a remembered or assumed state as a confirmed one. The fix is identical everywhere: re-acquire ground-truth **after** the change and confirm against it.

### Integration

- **`/verify`** — when a verification target is a web UI, use `verify-browser` for the browser leg: state the expected post-state, drive the browser through the loop above, and report only snapshot-confirmed results. Non-UI verification keeps using its existing run-and-observe path with the same discipline (step rules apply to the captured output).
- **Frontend / design skills** (e.g. `impeccable`, `audit`, `polish`, and live-iteration passes) — when a skill claims a visual or interaction change landed, ground that claim with a fresh a11y-tree snapshot through this skill before reporting it done.
- **`/code-review`** — when a review finding asserts runtime UI behavior, confirm it against a fresh snapshot rather than reasoning from the diff.

### Preconditions

- A reachable browser endpoint and the `chrome-devtools-axi` bridge available to the agent. If the bridge is not configured, this skill cannot produce ground-truth — say the check could not be grounded rather than reporting an unverified claim as success.

</supporting-info>
