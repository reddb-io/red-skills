# RedSkills Brain

The `brain` context names the project-local knowledge repository language for
RedSkills: human-facing captures, project brain files, typed connections,
folder-level brains, and GBrain-style knowledge dumping.

## Language

**Brain**:
The `brain` plugin's project-local RedDB knowledge repository for durable human
and project knowledge. It stores typed artifacts plus graph connections for
later search, synthesis, and visual exploration.
_Avoid_: memory, agent memory, notes folder

**Capture**:
The write operation that saves a durable piece of human or project knowledge
into Brain as a typed artifact. Captures go through `brain capture`, the
`brain_capture` MCP tool, or the Brain CLI; agents do not hand-write the Brain
store.
_Avoid_: memory write, note append, manual Brain edit

**Brain artifact**:
A typed knowledge item created by a Capture. Its `kind` is one of the canonical
artifact kinds defined in the Brain schema (`apps/brain/src/schema.ts`):
`pillar`, `decision`, `concept`, `question`, `playbook`, `task`, `event`,
`pattern`, `hypothesis`, `fact`, `source`, `bookmark`, `note`, `reference`,
`custom`, `project`, `idea`, `meeting`, `claim`, `organization`, `person`.
Brain artifacts are the nodes that search, think, dashboard, and view surfaces
cite.
_Avoid_: memory fact, raw note, row

**Project brain file**:
The RedDB store for a resolved Brain root, normally `.red/brain/brain.rdb` unless
configuration points to another connection string. It is the source of truth for
Brain artifacts and connections.
_Avoid_: graph.rdb, memory database, markdown brain

**Folder-level Brain**:
A Brain root shared by multiple child repositories through walk-up resolution:
the plugin prefers an explicit override, then an ancestor `.red/brain` directory
or `.red/brain.root` marker, then the nearest `.red/` fallback.
_Avoid_: global brain, monorepo memory, umbrella notes

**Connection**:
A typed graph edge between Brain artifacts. The canonical connection kinds
(`apps/brain/src/schema.ts`) are `supports`, `contradicts`, `depends_on`,
`derived_from`, `related_to`, `part_of`, `preceded_by`, `followed_by`,
`authored`, and `tagged`.
_Avoid_: backlink, loose link, relation

**GBrain-style dump**:
A freeform human-facing knowledge dump routed to Brain for later search,
connection, and synthesis. It may begin as an unstructured note, but it still
enters Brain through Capture and can later be split or connected as evidence
improves.
_Avoid_: scratchpad, chat memory, operational evidence

**Brain search**:
The deterministic lookup surface over captured Brain artifacts. Ranking combines
lexical matches, tags, artifact kind, graph connections, and a reserved vector
score slot.
_Avoid_: memory recall, grep, semantic memory

**Brain think**:
The cited synthesis surface over Brain search results. It returns grounded
answers with citations, confidence, and missing evidence instead of filling gaps
from uncited model knowledge.
_Avoid_: freeform answer, memory summary, unsupported synthesis

## Relationships

- Brain owns human-facing knowledge that the user wants to recall later.
- Memory owns operational evidence that helps agents work better.
- A Capture creates one or more Brain artifacts in a Project brain file.
- A Connection links two Brain artifacts with an explicit relationship kind.
- A Folder-level Brain lets child repositories share one Project brain file.
- Brain search returns ranked artifacts; Brain think synthesizes a cited answer
  from those artifacts.
- GBrain-style dumps are valid Brain input when they are captured rather than
  written directly into `.red/brain/`.

## Example dialogue

> **Brain:** "This is a long-lived decision about a person, organization, plan,
> or open question. Capture it in Brain."
>
> **Memory:** "This is a validated operational fact from the current work
> session. Store it in Memory instead."

## Flagged ambiguities

- "Brain" and "Memory" are intentionally separate contexts. Use **Brain** for
  human-facing recall and synthesis; use Memory for governed agent-operational
  evidence.
- "Connection" is not any markdown backlink. It is a typed Brain graph edge
  stored with Brain artifacts.
