# Structured eval corpus

`corpus.json` + `questions.json` back the default `benchmark-memory bench eval`
run. The fixture extends the original single-hop spine with two structural
categories where typed memory should be visible:

- `multi-hop`: a service decision links to a platform decision through a typed
  relation. The answer is the final fact in the support chain, and the eval only
  credits the answer when the full chain is present in the context pack.
- `temporal-as-of`: superseded decisions carry `valid_from`, `valid_until`,
  `supersedes`, and `superseded_by` metadata. The RedDB substrate applies the
  question's `as_of` timestamp before ranking. The plain Neo4j fixture is a term
  traversal and intentionally has no valid-time filter, so this category exposes
  the as-of gap.

Question records keep `gold_doc_id` for v1 readers and add `gold_doc_ids` for
full support chains. Single-hop questions omit `gold_doc_ids`; the loader treats
`gold_doc_id` as the one-element support list.

Run it:

```bash
benchmark-memory bench eval --json
benchmark-memory bench eval --records out/structured.jsonl --report out/structured.md
```
