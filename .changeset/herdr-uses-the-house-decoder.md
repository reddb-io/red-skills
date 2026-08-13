---
"@reddb-io/red-skills": patch
---

The herdr plugin reads the host lane with the house decoder

The plugin carried its own TOONL reader — a segment-header regex, a trailer
regex, a quoted-cell splitter and a value coercer — while already depending on
`@reddb-io/toon`, which owns that format. Nothing technical required it.

Three things had drifted behind that parser, and each was invisible until the
house decoder judged the same bytes:

- Its tail window opened AFTER the segment header its rows are declared by, so
  every row in the window was undecodable. Against the live 1.8 MB lane it
  yielded **zero** decodable records; the local reader survived that only by
  keeping the rows as raw text and calling it tolerance. The lane is read whole
  now, bounded by the writer's own 4 MiB compaction ceiling.
- Its tests asserted a header shape the daemon does not write (`{fields}:`
  rather than the canonical `[]{fields}:`), an empty cell where the writer emits
  `null`, and a JSON-line tolerance the daemon's own decoder does not have.
- A malformed row was absorbed as text. The house decoder stops and names it —
  `line 1600: row arity mismatch` — so the reader now keeps what decoded and
  hands back the reason, which a viewer can show. Loud and located beats silent
  and complete.

This also makes the host lane safe to extend. It already carries two segment
arities side by side, and a reader that mis-tracks a header decodes every later
row against the wrong fields.
