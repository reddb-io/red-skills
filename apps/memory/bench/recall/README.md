# Recall-quality bench corpus

`corpus.json` + `queries.json` back `memory bench recall` (issue #185).

Thirty short transcript chunks span operational shapes (`decision` / `fix` /
`gotcha` / `reasoning`) plus a handful of `chat` decoys; twenty-two queries
target a known relevant subset (`relevant_ids`). The split is deliberate —
operational queries with shared tags and a typed intent are the regime where
typed-graph + RRF should beat pure-vector recall; the `chat` decoys keep both
strategies honest.

The harness is fully in-process and deterministic: same corpus + queries on
the same git ref yield the same numbers run-to-run. Treat the corpus as a
fixture, not a leaderboard — add transcripts when a new operational shape
matters and re-publish the dated report under `../results/`.
