# Graph contract v1

`memory:export` writes a self-contained bundle (`graph.json`, `graph.html`, `audit.md`). Inside `graph.json` it embeds a **versioned contract** under the `contract` key — the stable integration seam between `memory:export` and any consumer (red-ui, scripts, future tools).

Everything else in `graph.json` (`health`, `evidence`, `contradictions`, `supersession`, `context_pack_preview`, the raw `nodes`/`edges` arrays, …) is diagnostic and may change between releases. **Consumers should read `graph.json#contract` and nothing else.**

The canonical, language-neutral schema is a JSON Schema (draft-07) returned by `graphContractJsonSchema()` in `src/graph-contract.ts`; `validateGraphContract(value)` validates a value against it.

## Consumers

`memory architecture-overview` is the first in-tree consumer: it reads the contract (from the store or, with `--from <graph.json>`, straight off `graph.json#contract`) and renders a single onboarding file summarising layers and communities by node count and connection count. It is built only from the contract above — no bespoke shape — so it stays consistent with any other tool reading the same seam, and it complements (rather than replaces) the wiki's C4/entity pages.

## Version negotiation

The contract carries a `version` (currently `1.0.0`, exported as `GRAPH_CONTRACT_VERSION`). Producers stamp it; consumers compare it before trusting the shape. A breaking change to any field below bumps the major version.

## Shape

```jsonc
{
  "version": "1.0.0",
  "nodes": [ /* ContractNode */ ],
  "edges": [ /* ContractEdge */ ],
  "stats": { /* ContractStats */ }
}
```

### `ContractNode`

| Field         | Type                  | Notes                                                                                  |
| ------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `id`          | integer               | Stable node id (RedDB rid).                                                             |
| `type`        | string                | Node type (`file`, `symbol`, `concept`, `decision`, …).                                |
| `label`       | string                | Stable label/key.                                                                      |
| `description` | string \| null        | Round-tripped from ingest: `properties.description`, else `summary`, else `content`.   |
| `exports`     | string[]              | Exported names round-tripped from ingest (`properties.exports`); `[]` when none.       |
| `layer`       | string \| null        | Physical memory layer (`L1`/`L2`/`L3`); `null` when unknown.                            |
| `community`   | string \| null        | Community/cluster id when `--communities` ran; `null` otherwise.                       |
| `orphan`      | boolean               | `true` when **no edge targets this node** (no inbound edges), computed at export time. |
| `metadata`    | object                | Remaining node properties, preserved losslessly.                                       |

### `ContractEdge`

| Field       | Type                                      | Notes                                                                    |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `source`    | integer                                   | Source node id. The edge points `source → target`.                       |
| `target`    | integer                                   | Target node id.                                                          |
| `kind`      | `"imports"` \| `"defines"` \| `"references"` | Directional kind the stored edge label collapses onto.                |
| `label`     | string                                    | Original stored edge label, preserved for traceability.                  |
| `direction` | `"directed"`                              | Edges are directed; `source → target` is the semantic direction.         |

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
