# Migrating from `agent-memory-server` (AMS)

The `memory` plugin is a local-first per-repo store. Redis's `agent-memory-server` is a hosted multi-tenant REST + MCP service. The two solve overlapping problems on opposite ends of the deployment spectrum, and there is **no wire compatibility** between them — by design (see [ADR 0005](../../../.red/adr/0005-memory-three-layer-reddb-architecture.md)).

Migration is a **one-shot offline import** of an AMS JSON dump into the local graph, plus a manual review of what features in AMS do not map across.

## What does map

| AMS concept                         | Memory plugin equivalent                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `working_memory[].session_id`       | `session-manager` session id (per-worktree)                                           |
| `working_memory[].memories[]`       | L2 typed event stream (`*_candidate` events) partitioned by session                   |
| `working_memory[].messages[]`       | L2 raw transcript blob (one per session — safety net for late re-extraction)          |
| `long_term_memory[]`                | L3 graph nodes, deduped against existing entries via the PromotionEngine              |
| `memory_type: decision/fix/...`     | Node `node_type`: `decision`, `fix`, `solution`, `problem`, `validation`, `why_note`  |
| `memory_type: semantic/episodic`    | Heuristically inferred (regex on text); falls back to `concept`                       |
| `namespace`                         | Stored as a tag `ams:<namespace>` for filterable recall                               |
| `created_at` / `updated_at` (ISO)   | Preserved on the imported node                                                        |
| `id`                                | Captured in provenance evidence (`ams_id:<id>`)                                       |
| Embeddings                          | Re-derived locally by running `memory refresh` after import (no embedding wire copy)  |

## What does **not** map

- **Hosted multi-tenant deployments** — the memory plugin is per-repo, embedded, no auth axis.
- **REST wire compatibility** — there is no REST surface. Use the CLI (`memory store`, `memory recall`, …) or MCP.
- **`user_id` axis** — identity is `(repo, session_id)`; the importer drops `user_id` from every entry.
- **LiteLLM-specific provider names** — LLM and embedding calls go through RedDB's `red.config.ai.provider` layer (`openai-native`, `anthropic-native`, `openai-compat`). If a LiteLLM provider has no equivalent there, it is out of scope.
- **Live shadow-read / AMS-compat mode** — the importer runs once; there is no "memory talks to AMS at runtime" path.

## Step-by-step

1. **Export from AMS.** From your AMS instance, produce a JSON dump of the shape:

   ```jsonc
   {
     "working_memory": [
       {
         "session_id": "...",
         "messages":  [{ "role": "...", "content": "...", "timestamp": "..." }],
         "memories":  [{ "id": "...", "text": "...", "memory_type": "...", "topics": [...], "created_at": "..." }]
       }
     ],
     "long_term_memory": [
       { "id": "...", "text": "...", "memory_type": "...", "session_id": "...", "namespace": "...", "created_at": "..." }
     ]
   }
   ```

   `working_memory` and `long_term_memory` are both optional — partial dumps import what is present.

2. **Initialize the memory plugin in graph mode** (if not already):

   ```sh
   memory init --mode graph
   ```

3. **Run the importer:**

   ```sh
   memory import ams ./ams-dump.json
   ```

   The importer:

   - Mints (or reuses) a session for each `working_memory` block and appends its `memories` as typed L2 events. Free-form text that starts with `Decision:`, `Fix:`, `Gotcha:`, `Why:`, `Problem:`, `Solution:`, `Validation:`, `Goal:` maps to the corresponding event_type / node_type.
   - Replaces the session's raw transcript blob with the AMS `messages` array (one transcript per block).
   - For each `long_term_memory` entry, builds an L3 candidate, runs the PromotionEngine dedup gate (semantic + keyword match against existing nodes), and either writes the new node or bumps the reinforcement counter on the matching existing node. Re-running the importer on the same dump is therefore idempotent — duplicates become reinforcements, not duplicates.
   - Detects import-time contradictions via the same `ConflictDetector` that guards live writes (issue #179). Conflicting facts (polarity flips on the same topic, divergent values for the same topic, byte-identical text from independent sessions) produce `CONTRADICTS` edges from the new node to the existing node — they are **not** silently deduped.

4. **Verify the import:**

   ```sh
   memory health
   memory recall "<query about an imported fact>"
   ```

   `memory health` reports total node count, layer breakdown, and the most recent engine ops. `memory recall` confirms that the imported facts are surfacing in the local recall path.

5. **(Optional) Rebuild embeddings** if you want vector recall over the imported corpus:

   ```sh
   memory refresh
   ```

   This re-derives embeddings through the RedDB provider layer; AMS embeddings are **not** copied.

## Notes on the heuristic mapping

The importer uses a deterministic regex + `memory_type` classifier — not an LLM — to keep migration reproducible and offline-friendly. If a `long_term_memory` entry does not match any prefix and has no explicit `memory_type`, it is stored as a `concept` node and surfaces in recall on keyword match only.

After import you can refine classifications with `memory doctor` (flags stale or low-signal nodes) and `memory recall` (validates that the entries you care about are findable).
