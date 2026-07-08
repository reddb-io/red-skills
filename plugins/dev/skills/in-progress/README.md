# In Progress

Skills that are still being developed. They're not ready to ship — expect rough edges, breaking changes, and abandoned experiments. They're excluded from the plugin and the top-level README until they graduate to a stable bucket.

- **[browser-review](./browser-review/SKILL.md)** — Open a generated HTML artifact for live human review over a local CLI↔browser bridge: the human annotates an exact element + character range, the agent polls the feedback, and a layout-audit gate blocks "done" on a broken render. Engine: `@reddb-io/browser-bridge`.
- **[review](./review/SKILL.md)** — Review changes since a fixed point along two parallel axes: **Standards** (does the diff follow the repo's coding standards?) and **Spec** (does the diff faithfully implement the originating issue/Spec?).
- **[writing-beats](./writing-beats/SKILL.md)** — Shape an article as a journey of beats, choose-your-own-adventure style. Pick a starting beat, write only that beat, then pivot to the next, until the article reaches a natural end.
- **[writing-fragments](./writing-fragments/SKILL.md)** — Grilling session that mines you for fragments — heterogeneous nuggets of writing — and appends them to a single document as raw material for a future article.
- **[writing-shape](./writing-shape/SKILL.md)** — Take a markdown file of raw material and shape it into an article paragraph by paragraph, arguing format choices at each step.
