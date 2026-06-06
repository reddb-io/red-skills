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

**Personal fact**:
A durable fact about a person, preference, contact, relationship, identity, habit, goal, or other human-facing context; it belongs in Brain as a Brain artifact, not in the Memory plugin's operational evidence graph.
_Avoid_: Memory node, Reasoning memory, agent-performance evidence

**Brain artifact kind**:
The required type of a Brain artifact. MVP kinds are rigid so the Brain can
route, search, and connect knowledge predictably from the start.
_Avoid_: freeform type, tag-only classification

**Brain vertex vocabulary**:
The MVP set of Brain artifact kinds and connection kinds, based on a
GBrain-style knowledge graph rather than a flat note store. Artifact kinds start
from pillar, decision, concept, question, playbook, task, event, pattern,
hypothesis, fact, source, bookmark, note, reference, custom, project, idea,
meeting, claim, organization, person, agent, workflow, rule, tool, output,
workspace, and department. `contact` is an ingestion alias that must resolve to
`person` or `organization` before persistence. Connection kinds start from
supports, contradicts, depends_on, derived_from, related_to, part_of,
preceded_by, followed_by, authored, and tagged. `tagged` is derived from
artifact tag metadata and may be rebuilt.
_Avoid_: untyped graph, tag-only graph

**AI OS artifact**:
A Brain artifact that represents an executable or reusable operating-system component such as an agent, workflow, rule, tool, output, workspace, or department.
_Avoid_: tag-only component, freeform operating-system note

**Brain workflow**:
A Brain artifact that describes a reusable sequence of work or decision steps inside the Brain's own vocabulary.
_Avoid_: n8n workflow, external automation target, runtime-specific flow

**Brain storm**:
A Brain-owned interview workflow that absorbs tacit human knowledge through
one-question-at-a-time grilling, checkpoints the evolving discovery record into
the Project brain, and later offers explicit promotion into Brain artifacts,
Memory operational evidence, or Dev documentation. Its initial persistence model
is hybrid: each checkpoint updates one structured session artifact, and granular
Brain artifacts are created only by an explicit promotion step.
_Avoid_: Dev start replacement, raw transcript dump, automatic Memory extraction

**Brain index**:
A curated Brain artifact that orients agents across a topic, workspace, project, or entity by summarizing relevant artifacts and pointing to where deeper context lives.
_Avoid_: automatic cache, search result, folder listing

**Generated Brain index**:
A derived view or cache that summarizes a slice of the Brain until a human or agent curates it into a **Brain index**.
_Avoid_: canonical artifact, promoted knowledge, durable decision

**Brain capture**:
The ingestion act that creates or updates a Brain artifact.
_Avoid_: memory store, transcript logging

**Brain automatic ingestion**:
An opt-in Brain capture path where brain-scoped connectors turn external events or context into Brain artifacts.
_Avoid_: capturing everything an agent sees, transcript scraping, Memory hook ingestion

**Brain connector boundary**:
The rule that external connector tools stay behind the Brain runtime and the agent sees only Brain-scoped operations.
_Avoid_: raw connector MCPs, generic messaging tools, tool-surface sprawl

**Brain graph explorer**:
The red-ui view over the Brain store used for early visual exploration and debugging of artifacts and connections.
_Avoid_: daily dashboard, curated operating surface

**Brain daily dashboard**:
A future curated Brain interface for recurring decisions, KPIs, and recent knowledge, considered only after graph exploration and event semantics are useful.
_Avoid_: red-ui replacement, first visualization surface, Memory Workbench

**Brain KPI**:
A Brain read over artifacts and connections that summarizes a decision-relevant count, trend, or status even before automatic event ingestion exists.
_Avoid_: decorative metric, separate analytics subsystem, dashboard-only number

**Brain structural KPI**:
An initial Brain KPI about the Brain itself, such as artifact counts by kind, connection counts, orphan artifacts, recent activity, and missing indexes.
_Avoid_: business KPI, manually reported metric, external analytics

**Brain store**:
The RedDB database owned by a Project brain and treated as the canonical source
of truth for captured knowledge and derived connections.
_Avoid_: markdown source of truth, export folder

**Brain markdown interop**:
A derived import/export surface that makes Brain artifacts readable in markdown-oriented tools while keeping the Brain store canonical.
_Avoid_: markdown source of truth, dual-write vault, Obsidian database

**Brain database boundary**:
The Brain store is separate from the Memory database. Brain and Memory may share
deployment patterns and integration points, but they must not share a canonical
database.
_Avoid_: shared memory database, memory namespace

**Brain-to-Memory federation**:
The read path where Memory recall or context-pack may rank cited Brain artifacts in the same result and trust model as Memory evidence, without moving Brain artifacts into the Memory store.
_Avoid_: shared canonical store, uncited Brain context, separate supplemental-only recall

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
_Avoid_: page, memory asset, standalone artifact, OCR source

**Brain operation contract**:
The initial GBrain-like operation set exposed by the Brain plugin: `init`,
`capture`, `search`, `get`, `link`, `backlinks`, `query`/`think`, and `status`.
_Avoid_: transcript recorder, memory operation

**Brain transport surfaces**:
The Brain plugin exposes one operation contract through CLI, MCP, and thin
skills. CLI is the local/testable surface, MCP is the agent tool surface, and
skills route human language to the operation contract.
_Avoid_: skill-only brain, duplicate command logic

**Brain connection pipeline**:
The two-stage process for creating Brain connections. Capture writes run fast
deterministic extraction first; optional asynchronous enrichment jobs may use an
LLM or provider to classify, summarize, and suggest additional connections.
_Avoid_: LLM-only graph, write-path enrichment

**Brain connection**:
A derived relationship between Brain captures, such as shared entities, topics,
references, decisions, contradictions, follow-ups, or provenance.
_Avoid_: memory edge, code reference

**Brain promotion**:
The act of copying a Brain artifact into a higher-level Brain, such as department or company, while preserving provenance back to the source artifact.
_Avoid_: moving the original, cross-brain live reference, shared mutable artifact

**Brain mission**:
Human-facing knowledge repository behavior: accept arbitrary dumps, preserve
them, and make connections across them for later recall and synthesis.
_Avoid_: agent performance memory, token optimization layer

**Brain operating model**:
Agents operate the Brain on behalf of the user, while humans inspect and correct Brain artifacts through readable views and explicit operations.
_Avoid_: markdown-first editing, human-only note system, fully automatic black box

**Memory mission**:
Agent-performance memory behavior in a separate Memory store: make agents work better through governed operational evidence, recall, context packs, telemetry, and token-efficient workflow support.
_Avoid_: personal knowledge repository
