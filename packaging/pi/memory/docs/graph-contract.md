# Graph contract v2

`memory map-contract --json` returns a **versioned contract** directly from the RedDB graph store — the stable integration seam between Memory state and any consumer (red-ui, scripts, future tools). The MCP tool `memory_map_contract` returns the same object for MCP clients.

`memory:export` also writes a self-contained bundle (`graph.json`, `graph.html`, `audit.md`). Inside `graph.json` it embeds the same contract under the `contract` key.

Everything else in `graph.json` (`health`, `evidence`, `contradictions`, `supersession`, `context_pack_preview`, the raw `nodes`/`edges` arrays, …) is diagnostic and may change between releases. **Consumers should read `graph.json#contract` and nothing else.**

The canonical, language-neutral schema is a JSON Schema (draft-07) returned by `graphContractJsonSchema()` in `src/graph-contract.ts`; `validateGraphContract(value)` validates a value against it.

The contract is deliberately data-only. It does **not** carry layout positions, palette/color choices, label visibility, opacity, hover behavior, selection state, filters, or interaction decisions. red-ui and other graph consumers decide those from their own product context while treating Memory as a RedDB-backed state producer.

## Consumers

`memory architecture-overview` is the first in-tree consumer: it reads the contract (from the store or, with `--from <graph.json>`, straight off `graph.json#contract`) and renders a single onboarding file summarising layers and communities by node count and connection count. It is built only from the contract above — no bespoke shape — so it stays consistent with any other tool reading the same seam, and it complements (rather than replaces) the wiki's C4/entity pages.

`memory map-contract --json` returns representative contract data from the configured RedDB store without writing files. `memory map-contract --communities --json` includes RedDB community ids when the store can compute them.

`memory export <out-dir>` writes representative contract data to `<out-dir>/graph.json`. The MCP tool `memory_export` returns the same contract inline when called without `out_dir`, or writes the bundle when `out_dir` is provided.

## Version negotiation

The contract carries a `version` (currently `2.0.0`, exported as `GRAPH_CONTRACT_VERSION`). Producers stamp it; consumers compare it before trusting the shape. A breaking change to any field below bumps the major version.

## Shape

```jsonc
{
  "version": "2.0.0",
  "nodes": [ /* ContractNode */ ],
  "edges": [ /* ContractEdge */ ],
  "stats": { /* ContractStats */ }
}
```

### `ContractNode`

| Field             | Type             | Notes                                                                                  |
| ----------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `id`              | integer          | Stable node id (RedDB rid).                                                            |
| `type`            | string           | Node type (`file`, `symbol`, `concept`, `decision`, …).                                |
| `label`           | string           | Stable label/key.                                                                      |
| `description`     | string \| null   | Round-tripped from ingest: `properties.description`, else `summary`, else `content`.   |
| `exports`         | string[]         | Exported names round-tripped from ingest (`properties.exports`); `[]` when none.       |
| `layer`           | string \| null   | Physical memory layer (`L1`/`L2`/`L3`); `null` when unknown.                           |
| `community`       | string \| null   | Community/cluster id when `--communities` ran; `null` otherwise.                       |
| `confidence`      | string \| null   | Stored confidence (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`, or future string); `null` when unavailable. |
| `source_location` | string \| null   | Canonical source path/range/URN from `source_location` or `source`; `null` when unavailable. |
| `provenance`      | object \| null   | Stored provenance object; `null` when unavailable.                                     |
| `provenance_tier` | `"oracle"` \| `"proxy"` \| null | Stored authority tier; missing legacy values are treated as `proxy` by Memory recall. |
| `freshness`       | object           | `created_at`, `updated_at`, optional `accessed_at` and `expires_at`, all epoch ms or `null`. |
| `salience`        | number \| null   | Node salience for ranking/filtering; `null` when unavailable.                          |
| `orphan`          | boolean          | `true` when **no edge targets this node** (no inbound edges), computed at export time. |
| `metadata`        | object           | Remaining node properties, preserved losslessly.                                       |

### `ContractEdge`

| Field             | Type                                      | Notes                                                                    |
| ----------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `id`              | integer                                   | Stable edge id (RedDB rid).                                              |
| `source`          | integer                                   | Source node id. The edge points `source → target`.                       |
| `target`          | integer                                   | Target node id.                                                          |
| `kind`            | `"imports"` \| `"defines"` \| `"references"` | Directional kind the stored edge label collapses onto.                |
| `label`           | string                                    | Original stored edge label, preserved for traceability.                  |
| `weight`          | number                                    | RedDB edge weight. This is separate from `salience`.                     |
| `salience`        | number \| null                            | Consumer ranking salience; `null` when unavailable.                      |
| `confidence`      | string \| null                            | Stored confidence (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`, or future string); `null` when unavailable. |
| `source_location` | string \| null                            | Canonical source path/range/URN from `source_location` or `source`; `null` when unavailable. |
| `provenance`      | object \| null                            | Stored provenance object; `null` when unavailable.                       |
| `provenance_tier` | `"oracle"` \| `"proxy"` \| null           | Stored authority tier; missing legacy values are treated as `proxy` by Memory recall. |
| `freshness`       | object                                    | `created_at`, `updated_at`, optional `expires_at`, all epoch ms or `null`. |
| `direction`       | `"directed"`                              | Edges are directed; `source → target` is the semantic direction.         |
| `metadata`        | object                                    | Remaining edge properties, preserved losslessly.                         |

Every stored edge label maps onto exactly one kind:

| Kind         | Stored labels                              | Direction note                                                       |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| `imports`    | `IMPORTS`                                  | `source` imports `target`.                                           |
| `defines`    | `DEFINED_IN` (flipped), `CONTAINS`         | Always reads parent→child. `DEFINED_IN` is stored symbol→file, so it is flipped to file→symbol. |
| `references` | everything else, **and any unknown label** | Lossless, safe default — a new edge label never breaks a consumer.   |

### `ContractStats`

| Field             | Type                              | Notes                                            |
| ----------------- | --------------------------------- | ------------------------------------------------ |
| `node_count`      | integer                           | Number of nodes.                                 |
| `edge_count`      | integer                           | Number of edges.                                 |
| `orphan_count`    | integer                           | Nodes with no inbound edges.                     |
| `community_count` | integer                           | Distinct non-null community ids.                 |
| `edge_kinds`      | `{ imports, defines, references }`| Edge count per kind.                             |
| `node_types`      | `{ [type]: count }`               | Node count per type.                             |
