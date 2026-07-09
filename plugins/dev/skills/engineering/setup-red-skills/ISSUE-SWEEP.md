# Setup RedSkills Issue Sweep

## Sweep existing issues

If the repo already has open issues, the new label vocabulary won't apply itself. Help the user backfill so `/triage` and `/afk` see a coherent state.

Run `gh issue list --state open --limit 200 --json number,title,labels` and group:

- **Unlabelled / missing triage role** — candidates for `needs-triage`
- **Labelled with legacy names** — map to the canonical vocabulary from Section B
- **Labels outside the accepted families** — remove them; do not map historical routing labels to another label
- **Already correct** — skip

Skip the sweep entirely if `gh issue list` returns 0 open issues.

Present the grouping to the user as a compact table (number, title, current labels, proposed labels) and ask for batch approval. Don't apply per-issue — one confirmation, then loop `gh issue edit <n> --add-label ... --remove-label ...`. If the list is large (>30), offer to do only the first N and stop.

Never close, reassign, or edit issue bodies in this step — labels only.
