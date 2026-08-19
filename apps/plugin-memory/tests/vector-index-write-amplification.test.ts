import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { MemoryVectorProjection } from "../src/graph-store/vector-projection.js";

/**
 * A maintenance pass over N vectors must write the aggregate local index ONCE.
 *
 * The index names every projected vector, so writing it after each record makes
 * the pass quadratic in bytes on a store that keeps every version: #3970
 * reported 2233 vectors turning a 186 KB store into 3.75 GB. Counting index
 * puts is the honest observation — it is the amplification itself, not a
 * proxy for it.
 */
const INDEX_KEY = "vector:local:index";

class CountingKv {
  readonly puts: string[] = [];
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.puts.push(key);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  indexWrites(): number {
    return this.puts.filter((key) => key === INDEX_KEY).length;
  }
}

function nodes(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    rid: index + 1,
    label: `node-${index + 1}`,
    node_type: "note",
    properties: { content: `content ${index + 1}`, project: "test" },
  }));
}

let previousProvider: string | undefined;

beforeEach(() => {
  previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
  process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
});

afterEach(() => {
  if (previousProvider === undefined) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
  else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
});

function projectionOver(kv: CountingKv, count: number): MemoryVectorProjection {
  return new MemoryVectorProjection({
    // The local path never reaches the database: a query here is the test
    // telling us the provider was not honoured.
    db: {
      query: () => {
        throw new Error("the local vector path must not query the database");
      },
    } as never,
    kv: () => kv as never,
    project: "test",
    listNodes: async () => nodes(count) as never,
    listDocs: async () => [],
  });
}

describe("local vector maintenance writes its index once per pass", () => {
  test("one pass over many vectors writes the aggregate index exactly once", async () => {
    const kv = new CountingKv();

    await projectionOver(kv, 50).maintainVectorProjection();

    expect(kv.indexWrites()).toBe(1);
    // Every vector is still individually written — the batching is the index,
    // never the records.
    expect(kv.puts.filter((key) => key !== INDEX_KEY)).toHaveLength(50);
  });

  test("the index the pass leaves behind names every projected vector", async () => {
    const kv = new CountingKv();

    await projectionOver(kv, 8).maintainVectorProjection();

    const index = (await kv.get(INDEX_KEY)) as Record<string, string>;
    expect(Object.keys(index)).toHaveLength(8);
  });

  test("index cost does not grow with the square of the vector count", async () => {
    const small = new CountingKv();
    const large = new CountingKv();

    await projectionOver(small, 10).maintainVectorProjection();
    await projectionOver(large, 100).maintainVectorProjection();

    expect(small.indexWrites()).toBe(1);
    expect(large.indexWrites()).toBe(1);
  });
});
