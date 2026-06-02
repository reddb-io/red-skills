# RedSkills Brain

The `brain` context names a project-local knowledge repository for freeform
captures, human-facing recall, and cross-note connection. Brain is analogous in
purpose to GBrain, but lives inside RedSkills project conventions.

## Language

**Brain plugin**:
The RedSkills plugin that creates and operates a project-local knowledge
repository under `.red/brain/*`.
_Avoid_: memory mode, gbrain wrapper

**Project brain**:
The `.red/brain/*` repository for one working directory, initialized when an
agent session starts in that directory and used to store the RedDB-backed source
of truth, freeform knowledge captures, attachments, and derived connections.
_Avoid_: memory graph, wiki cache

**Brain artifact**:
The canonical stored knowledge object in a Project brain. An artifact may come
from conversation residue, notes, documents, decisions, questions, plans,
references, or any other durable knowledge dump.
_Avoid_: memory note, page

**Brain artifact kind**:
The required type of a Brain artifact. MVP kinds are rigid so the Brain can
route, search, and connect knowledge predictably from the start.
_Avoid_: freeform type, tag-only classification

**Brain vertex vocabulary**:
The MVP set of Brain artifact kinds and connection kinds, based on a
GBrain-style knowledge graph rather than a flat note store. Artifact kinds start
from pillar, decision, concept, question, playbook, task, event, pattern,
hypothesis, fact, source, bookmark, note, reference, custom, project, idea,
meeting, claim, organization, and person. `contact` is an ingestion alias that
must resolve to `person` or `organization` before persistence. Connection kinds
start from supports, contradicts, depends_on, derived_from, related_to, part_of,
preceded_by, followed_by, authored, and tagged. `tagged` is derived from
artifact tag metadata and may be rebuilt.
_Avoid_: untyped graph, tag-only graph

**Brain capture**:
The ingestion act that creates or updates a Brain artifact.
_Avoid_: memory store, transcript logging

**Brain store**:
The RedDB database owned by a Project brain and treated as the canonical source
of truth for captured knowledge and derived connections.
_Avoid_: markdown source of truth, export folder

**Brain database boundary**:
The Brain store is separate from the Memory database. Brain and Memory may share
deployment patterns and integration points, but they must not share a canonical
database.
_Avoid_: shared memory database, memory namespace

**Brain deployment target**:
The configured location of a Brain store. The default target is offline-first
local storage under the project, while advanced targets may use a connection
string for Docker, reddb.io, self-hosted RedDB, or another supported RedDB
deployment.
_Avoid_: cloud-only brain, local-only brain

**Brain connection string**:
The single configuration value that selects a Brain store location. The default
is `file://./.red/brain/brain.rdb`; operators may set it directly or reference
an environment variable.
_Avoid_: engine flag matrix, backend mode enum

**Brain env interpolation**:
The config-resolution step that expands `$NAME` or `${NAME}` values in
`connection_string` using process environment first, then the workspace root
`.env` file that sits beside `.red/`.
_Avoid_: secret persistence, shell-only config

**Brain workspace root**:
The directory that owns `.red/brain/*`. Resolve it by walking upward from the
agent's initial working directory until `.red/` is found; if none exists, use
the initial working directory and create `.red/brain/*` there.
_Avoid_: git-root-only brain, process cwd drift

**Brain attachment**:
A file associated with a Brain artifact, such as a document, transcript, image,
audio file, or exported markdown. Attachments may live under `.red/brain/*`, but
they are not the canonical source of truth.
_Avoid_: page, memory asset

**Brain operation contract**:
The initial GBrain-like operation set exposed by the Brain plugin: `init`,
`capture`, `search`, `get`, `link`, `backlinks`, `query`/`think`, and `status`.
_Avoid_: transcript recorder, memory operation

**Brain connection pipeline**:
The two-stage process for creating Brain connections. Capture writes run fast
deterministic extraction first; optional asynchronous enrichment jobs may use an
LLM or provider to classify, summarize, and suggest additional connections.
_Avoid_: LLM-only graph, write-path enrichment

**Brain connection**:
A derived relationship between Brain captures, such as shared entities, topics,
references, decisions, contradictions, follow-ups, or provenance.
_Avoid_: memory edge, code reference

**Brain mission**:
Human-facing knowledge repository behavior: accept arbitrary dumps, preserve
them, and make connections across them for later recall and synthesis.
_Avoid_: agent performance memory, token optimization layer

**Memory mission**:
Agent-performance memory behavior: make agents work better through governed
operational evidence, recall, context packs, telemetry, and token-efficient
workflow support.
_Avoid_: personal knowledge repository
