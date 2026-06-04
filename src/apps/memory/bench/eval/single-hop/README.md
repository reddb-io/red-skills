# Single-hop eval corpus

`corpus.json` + `questions.json` back `benchmark-memory bench eval` — the
deterministic eval spine (issue #334, parent PRD #333, ADR 0037).

Each question is **single-hop**: its answer lives in exactly one corpus entry
(`gold_doc_id`), and `gold_answer` is the **exact gold** — equal to that entry's
canonical `fact`. The pipeline is:

```
corpus + question
  → governed-recall substrate builds a fixed context pack (top-k entries)
  → the fixed-pack answerer reads the top entry's fact
  → exact-match / token-F1 scorer scores against gold
  → raw per-question records → JSONL
```

Corpus entries carry the two ADR 0035 axes (`structural_type`, the closed axis;
`engineering_code`, the open one) so the substrate has a typed signal to rank
on, not just body text — that is the structure plain flat notes lack.

The whole path is a pure function of the checked-in fixtures: same git ref ⇒
identical scores and identical JSONL bytes. This remains the single-hop control
fixture. The default eval corpus now lives in `../structured/` and adds
multi-hop chains plus temporal as-of supersessions on the same `ContextPack` and
`QuestionRecord` shapes.

Run it:

```bash
benchmark-memory bench eval --json
benchmark-memory bench eval --records out/single-hop.jsonl --report out/single-hop.md
```
