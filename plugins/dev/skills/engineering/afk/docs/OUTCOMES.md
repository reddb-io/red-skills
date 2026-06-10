# Attempt Outcomes & Recovery Caps

AFK labels terminal failures with a typed `blocked:<reason>` label. Recoverable reasons retry; at/over the cap they escalate to `ready-for-human`:

| Outcome | typed label | recovery | default cap |
|---|---|---|---|
| `done` | none | none | n/a |
| `blocked` | `blocked:spec` | none — escalates immediately | n/a |
| `no-sentinel` | `blocked:crashed` | `crashed` | `RED_AFK_RETRY_CRASH=1` |
| `merge-conflict` | `blocked:merge-conflict` | `merge-conflict` | `RED_AFK_RETRY_MERGE=3` |
| `exhausted` | `blocked:quota` | `quota` | `RED_AFK_RETRY_QUOTA=3` |
| `runner-transient` | `blocked:runner-transient` | `runner-transient` | `RED_AFK_RETRY_RUNNER_TRANSIENT=3` |
| `feedback-failed` | `blocked:validation` | none — escalates immediately | n/a |
| `hook-aborted` | `blocked:policy` | none — escalates immediately | n/a |
| `stalled` | `blocked:stalled` | none — escalates immediately | n/a |
| `infra` | `blocked:infra` | none — escalates immediately | n/a |
