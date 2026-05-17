# Example — Book reading wiki

A repo dedicated to a single reading: "The Fellowship of the Ring" (Tolkien).

## After `/wiki-init`

`.red/agents/wiki.md`:
- `{{domain}}` = "companion wiki for reading The Lord of the Rings"
- `{{source-types}}` = "book chapters (personal notes in md), academic commentary (PDFs), Tolkien interviews (transcripts)"
- `{{voice}}` = "first person (solo)"

## Emergent convention

After ingesting the first chapter, the agent asks: "Chapters are the common source here — want a naming pattern?" The user agrees on `ch01-<slug>.md`. The agent **adds it to the schema** (`.red/agents/wiki.md`):

```markdown
## Naming exceptions

- **Book chapters:** `ch<NN>-<slug>.md` (zero-padded, NN from 01 to 22). Example: `ch01-a-long-expected-party.md`.
```

## After 5 chapters

```
pages/
├── ch01-a-long-expected-party.md   # type: source
├── ch02-the-shadow-of-the-past.md  # type: source
├── ch03-three-is-company.md        # type: source
├── ch04-a-short-cut-to-mushrooms.md
├── ch05-a-conspiracy-unmasked.md
├── frodo-baggins.md                # type: entity, sources: 5
├── bilbo-baggins.md                # type: entity, sources: 2
├── gandalf.md                      # type: entity, sources: 3
├── samwise-gamgee.md               # type: entity, sources: 3
├── the-shire.md                    # type: entity (place)
├── the-one-ring.md                 # type: entity (object)
├── ring-bearer.md                  # type: concept
├── eucatastrophe.md                # type: concept
└── ring-temptation-patterns.md     # type: synthesis (4 sources)
```

Typical query: "how does the Ring affect each bearer?" → the agent reads the relevant pages, builds a comparison table, and offers to file it back as `pages/ring-bearer-effects.md` (synthesis).
