---
"@reddb-io/red-skills": patch
---

Sweep reads reach the tracker again, and a blind one says so

Every sweep listing was issuing `gh api --paginate --slurp … --jq …`, a flag
combination the `gh` binary refuses outright (`the --slurp option is not
supported with --jq or --template`). Each caller read the resulting non-zero
exit as an empty collection, so the Unblock Sweep, the close cascade's dependent
lookup, the parked-mechanical sweep, the open-PR census and the handoff comment
read all reported "nothing found" against a full tracker. The Unblock Sweep
answered `promoted: []` with two issues promotable and every `req:` blocker
already closed; the comment read returned no comments, which is how Directive
blocks carrying human guidance quietly stopped reaching Workers.

The listings now paginate through the shared `@reddb-io/github` client, which
removes the category rather than the instance: there is no argv to get wrong,
page walking belongs to the client, and the reads inherit conditional caching,
spend attribution and the retry policy the CLI path forfeited. A read that still
fails answers with the same conservative empty collection — a sweep blind to the
tracker must promote nothing — but now names the failure on stderr first, because
an unreachable read and a quiet repository used to produce identical output.
