import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EMPTY_ENGINEERING_CODE_CURATION,
  aliasEngineeringCode,
  isCuratedSuggestedEngineeringCode,
  promoteEngineeringCode,
  resolveEngineeringCodeAlias,
  type EngineeringCodeCurationState,
} from "../src/code-curation.js";
import { buildCodeDriftReport } from "../src/code-drift-report.js";
import { EXTRACTION_PROFILES, STRUCTURAL_TYPES } from "../src/extraction-schema.js";
import { type ExtractedFact, factsToGraph } from "../src/extract-conversation.js";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore, type StoredNode } from "../src/graph-store.js";
import { EDGE_LABELS, HIDDEN_BY_EDGE_LABELS, NODE_TYPES, type EdgeLabel } from "../src/schema.js";

const TIMEOUT = 45_000;
const NOW = Date.UTC(2026, 0, 1);
const SEEDS = [0xa11ce, 0xbad5eed, 0xc0ffee] as const;
const OPS_PER_SEED = 22;
const SOFT_MERGE_LABELS = ["SAME_AS", "MERGED_INTO"] as const;
const UNKNOWN_CODES = ["footgun", "smell", "yak-shave", "incident-pattern"] as const;
const PROPOSED_KINDS = [
  "decision",
  "validation",
  "not-a-type",
  "benchmark-result",
  "root cause",
  "workflow",
] as const;

const roots: string[] = [];
const stores: MemoryStore[] = [];

interface ModelNode {
  rid: number;
  token: string;
  hidden?: { to: number; label: EdgeLabel };
  inferred: boolean;
}

interface FuzzerState {
  seed: number;
  step: number;
  nextId: number;
  nodes: Map<number, ModelNode>;
  curation: EngineeringCodeCurationState;
  lastOp: string;
}

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-invariant-fuzzer-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("memory invariant fuzzer (VOPR-lite)", () => {
  test("hidden-by labels remain legal edge labels", () => {
    expect(EDGE_LABELS).toEqual(expect.arrayContaining([...HIDDEN_BY_EDGE_LABELS]));
  });

  test.each(SEEDS)(
    "seed %# keeps supersession, soft-merge, extraction, and code-drift invariants",
    async (seed) => {
      const store = await openStore(await tempRoot());
      const rng = mulberry32(seed);
      const state: FuzzerState = {
        seed,
        step: 0,
        nextId: 0,
        nodes: new Map(),
        curation: { ...EMPTY_ENGINEERING_CODE_CURATION },
        lastOp: "bootstrap",
      };

      for (let i = 0; i < 4; i++) {
        await addManualNode(store, state, `bootstrap-${i}`);
      }
      await assertInvariants(store, state);

      for (let step = 1; step <= OPS_PER_SEED; step++) {
        state.step = step;
        const roll = rng();
        if (roll < 0.24) {
          await addManualNode(store, state, `manual-${step}`);
        } else if (roll < 0.42) {
          await supersedeActiveNode(store, state, rng);
        } else if (roll < 0.60) {
          await softMergeActiveNode(store, state, rng);
        } else if (roll < 0.72) {
          await unmergeDuplicate(store, state, rng);
        } else if (roll < 0.86) {
          await addInferredFact(store, state, rng);
        } else {
          await addOrCurateCode(store, state, rng);
        }

        await assertInvariants(store, state);
      }
    },
    TIMEOUT,
  );
});

async function addManualNode(
  store: MemoryStore,
  state: FuzzerState,
  reason: string,
): Promise<number> {
  const id = state.nextId++;
  const token = tokenFor(state, id);
  const rid = await store.upsertNode({
    label: `vopr-${state.seed.toString(16)}-${id}`,
    node_type: "concept",
    properties: {
      title: `VOPR ${id}`,
      content: `memory invariant marker ${token} ${reason}`,
      created_at: NOW + id,
      updated_at: NOW + id,
    },
  });
  state.nodes.set(rid, { rid, token, inferred: false });
  state.lastOp = `addManual(${rid})`;
  return rid;
}

async function addInferredFact(
  store: MemoryStore,
  state: FuzzerState,
  rng: () => number,
): Promise<void> {
  const id = state.nextId++;
  const token = tokenFor(state, id);
  const proposedKind = pick(PROPOSED_KINDS, rng);
  const fact: ExtractedFact = {
    label: `inferred-${state.seed.toString(16)}-${id}`,
    node_type: proposedKind,
    title: `Inferred ${id}`,
    summary: `inferred marker ${token} proposed kind ${proposedKind}`,
    tags: ["vopr"],
    relations: [],
  };
  const graph = factsToGraph([fact], "invariant-fuzzer");
  expect(graph.nodes, clue(state, `factsToGraph retained ${proposedKind}`)).toHaveLength(1);
  const node = graph.nodes[0]!;
  const resolution = EXTRACTION_PROFILES.strictWrite.resolve(proposedKind);

  expect(NODE_TYPES, clue(state, `valid node_type for ${proposedKind}`)).toContain(node.node_type);
  expect(STRUCTURAL_TYPES, clue(state, `valid structural_type for ${proposedKind}`)).toContain(
    node.properties.structural_type,
  );
  expect(node.properties.structural_type, clue(state, "strict-write structural resolution")).toBe(
    resolution.structuralType,
  );
  expect(node.properties.confidence, clue(state, "inferred fact is not quarantined")).toBe(
    "INFERRED",
  );

  const rid = await store.upsertNode({
    ...node,
    properties: {
      ...node.properties,
      created_at: NOW + id,
      updated_at: NOW + id,
    },
  });
  state.nodes.set(rid, { rid, token, inferred: true });
  state.lastOp = `addInferred(${rid}, ${proposedKind})`;
}

async function addOrCurateCode(
  store: MemoryStore,
  state: FuzzerState,
  rng: () => number,
): Promise<void> {
  const recurring = recurringUnknownCodes(await store.listNodes(NOW), state.curation);
  if (recurring.length > 0 && rng() < 0.35) {
    const code = pick(recurring, rng);
    state.curation = promoteEngineeringCode(state.curation, code).state;
    state.lastOp = `promoteCode(${code})`;
    return;
  }
  if (recurring.length > 0 && rng() < 0.35) {
    const code = pick(recurring, rng);
    state.curation = aliasEngineeringCode(state.curation, code, "gotcha").state;
    state.lastOp = `aliasCode(${code}->gotcha)`;
    return;
  }

  const id = state.nextId++;
  const token = tokenFor(state, id);
  const code = pick(UNKNOWN_CODES, rng);
  const rid = await store.upsertNode({
    label: `coded-${state.seed.toString(16)}-${id}`,
    node_type: "concept",
    properties: {
      title: `Coded ${id}`,
      content: `engineering code marker ${token}`,
      engineering_code: code,
      created_at: NOW + id,
      updated_at: NOW + id,
    },
  });
  state.nodes.set(rid, { rid, token, inferred: false });
  state.lastOp = `addCode(${rid}, ${code})`;

  const hits = await graphRecall(store, code, 10, { now: NOW });
  expect(hits.map((hit) => hit.rid), clue(state, `unknown code ${code} is indexed`)).toContain(
    rid,
  );
}

async function supersedeActiveNode(
  store: MemoryStore,
  state: FuzzerState,
  rng: () => number,
): Promise<void> {
  const [old, current] = pickPair(activeNodes(state), rng);
  if (!old || !current) {
    await addManualNode(store, state, "supersede-fallback");
    return;
  }
  await store.supersede(old.rid, current.rid, "invariant fuzzer supersession");
  old.hidden = { to: current.rid, label: "SUPERSEDED_BY" };
  state.lastOp = `supersede(${old.rid}->${current.rid})`;
}

async function softMergeActiveNode(
  store: MemoryStore,
  state: FuzzerState,
  rng: () => number,
): Promise<void> {
  const [duplicate, canonical] = pickPair(activeNodes(state), rng);
  if (!duplicate || !canonical) {
    await addManualNode(store, state, "soft-merge-fallback");
    return;
  }
  const label = pick(SOFT_MERGE_LABELS, rng);
  await store.upsertEdge({
    label,
    from_rid: duplicate.rid,
    to_rid: canonical.rid,
    properties: { reason: "invariant fuzzer soft merge" },
  });
  duplicate.hidden = { to: canonical.rid, label };
  state.lastOp = `softMerge(${duplicate.rid}->${canonical.rid}, ${label})`;
}

async function unmergeDuplicate(
  store: MemoryStore,
  state: FuzzerState,
  rng: () => number,
): Promise<void> {
  const merge = pick(
    [...state.nodes.values()].filter((node) => node.hidden && isSoftMergeLabel(node.hidden.label)),
    rng,
  );
  if (!merge?.hidden) {
    await addManualNode(store, state, "unmerge-fallback");
    return;
  }

  const before = await store.getNode(merge.rid);
  expect(before, clue(state, `merged node ${merge.rid} exists before unmerge`)).not.toBeNull();
  await expect(
    store.removeEdge(merge.rid, merge.hidden.to, merge.hidden.label),
    clue(state, `remove merge edge ${merge.rid}->${merge.hidden.to}`),
  ).resolves.toBe(true);

  const after = await store.getNode(merge.rid);
  expect(after, clue(state, `merged node ${merge.rid} exists after unmerge`)).toEqual(before);
  merge.hidden = undefined;
  state.lastOp = `unmerge(${merge.rid})`;

  const hits = await graphRecall(store, merge.token, 10, { now: NOW });
  expect(hits.map((hit) => hit.rid), clue(state, `unmerged node ${merge.rid} recalled`)).toContain(
    merge.rid,
  );
}

async function assertInvariants(store: MemoryStore, state: FuzzerState): Promise<void> {
  await assertHiddenNodesDoNotSurface(store, state);
  await assertInferredFactsHaveStructuralTypes(store, state);
  await assertCodeDriftHasCurationPath(store, state);
}

async function assertHiddenNodesDoNotSurface(
  store: MemoryStore,
  state: FuzzerState,
): Promise<void> {
  for (const node of state.nodes.values()) {
    if (!node.hidden) continue;
    const head = resolveHead(state, node.rid);
    const hits = await graphRecall(store, node.token, 10, { now: NOW });
    const rids = hits.map((hit) => hit.rid);
    expect(rids, clue(state, `hidden ${node.hidden.label} node ${node.rid} is absent`)).not.toContain(
      node.rid,
    );
    expect(rids, clue(state, `hidden node ${node.rid} resolves to active head ${head}`)).toContain(
      head,
    );
  }
}

async function assertInferredFactsHaveStructuralTypes(
  store: MemoryStore,
  state: FuzzerState,
): Promise<void> {
  for (const model of state.nodes.values()) {
    if (!model.inferred) continue;
    const node = await store.getNode(model.rid);
    expect(node, clue(state, `inferred node ${model.rid} exists`)).not.toBeNull();
    expect(NODE_TYPES, clue(state, `inferred node ${model.rid} has valid node_type`)).toContain(
      node?.node_type,
    );
    expect(
      STRUCTURAL_TYPES,
      clue(state, `inferred node ${model.rid} has valid structural_type`),
    ).toContain(node?.properties.structural_type);
    expect(node?.properties.confidence, clue(state, `inferred node ${model.rid} confidence`)).toBe(
      "INFERRED",
    );
  }
}

async function assertCodeDriftHasCurationPath(
  store: MemoryStore,
  state: FuzzerState,
): Promise<void> {
  const nodes = await store.listNodes(NOW);
  const report = buildCodeDriftReport(
    nodes.map((node) => node.properties.engineering_code),
    {
      curation: state.curation,
      canonicalize: (code) => resolveEngineeringCodeAlias(code, state.curation),
      isSuggested: (code) => isCuratedSuggestedEngineeringCode(code, state.curation),
    },
  );

  const unknown = recurringUnknownCodes(nodes, state.curation);
  for (const code of unknown) {
    expect(
      report.recurring.map((entry) => entry.code),
      clue(state, `recurring unknown code ${code} is surfaced`),
    ).toContain(resolveEngineeringCodeAlias(code, state.curation));
    expect(
      () => promoteEngineeringCode(state.curation, code),
      clue(state, `recurring code ${code} has promote path`),
    ).not.toThrow();
    expect(
      () => aliasEngineeringCode(state.curation, code, "gotcha"),
      clue(state, `recurring code ${code} has alias path`),
    ).not.toThrow();
  }
}

function recurringUnknownCodes(
  nodes: StoredNode[],
  curation: EngineeringCodeCurationState,
): string[] {
  const report = buildCodeDriftReport(
    nodes.map((node) => node.properties.engineering_code),
    {
      curation,
      canonicalize: (code) => resolveEngineeringCodeAlias(code, curation),
      isSuggested: (code) => isCuratedSuggestedEngineeringCode(code, curation),
    },
  );
  return report.recurring.map((entry) => entry.code);
}

function activeNodes(state: FuzzerState): ModelNode[] {
  return [...state.nodes.values()].filter((node) => !node.hidden);
}

function resolveHead(state: FuzzerState, rid: number): number {
  const seen = new Set<number>();
  let current = rid;
  while (!seen.has(current)) {
    seen.add(current);
    const next = state.nodes.get(current)?.hidden?.to;
    if (next == null) return current;
    current = next;
  }
  return current;
}

function tokenFor(state: FuzzerState, id: number): string {
  return `vopr${state.seed.toString(16)}node${id}`;
}

function pick<T>(values: readonly T[], rng: () => number): T {
  return values[Math.floor(rng() * values.length) % values.length]!;
}

function pickPair<T>(values: readonly T[], rng: () => number): [T | null, T | null] {
  if (values.length < 2) return [null, null];
  const firstIndex = Math.floor(rng() * values.length) % values.length;
  let secondIndex = Math.floor(rng() * values.length) % values.length;
  if (secondIndex === firstIndex) secondIndex = (secondIndex + 1) % values.length;
  return [values[firstIndex]!, values[secondIndex]!];
}

function isSoftMergeLabel(label: EdgeLabel): label is (typeof SOFT_MERGE_LABELS)[number] {
  return (SOFT_MERGE_LABELS as readonly EdgeLabel[]).includes(label);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clue(state: FuzzerState, assertion: string): string {
  return `seed=${state.seed} step=${state.step} op=${state.lastOp}: ${assertion}`;
}
