# Terminal-Event Envelope

Every terminal event posts **exactly one** structured comment on the issue. Envelopes are the canonical record of what the worker saw and did.

| status | trigger |
|---|---|
| `blocked` | spec block, validation failure, or generic failure |
| `no-sentinel` | inner agent exited without `<promise>` |
| `merge-conflict` | orchestrator could not merge to `{pinned}` |
| `done` | success — merged, closing |
| `discarded` | supervisor circuit-breaker discard |

Schema:

```html
<details data-attempt-status="blocked">
<summary>worker `wZ2R4` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1</summary>

<details data-section="notes"><summary>notes</summary>
{handoff `<agent-notes>` body}
</details>

</details>
```

Every non-`discarded` terminal envelope also carries a trailing `data-section="hooks"` block when at least one **user-declared** lifecycle hook ran (not built-ins), listing each hook's name, command, and exit code.

On terminal failure, the live iteration branch (`afk/{id}/{N}-{slug}`) survives on origin for inspection; a failure-only marker (`afk-attempts/{id}/{N}-{slug}`) is also pushed for forensics. On DONE the live branch is deleted after close.
