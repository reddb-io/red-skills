import { defineConfig } from "vitest/config";
import { integrationGlobs } from "./vitest.suites.js";

// #242: default AFK feedback gate. Fast and deterministic — excludes the
// process-spawning / latency-budget suite (see vitest.suites.ts) and uses a
// generous per-test timeout so CPU contention cannot trip an otherwise-correct
// test.
//
// fileParallelism stays OFF: several in-process suites share the SDK-managed
// `memory_docs` / `memory_nodes` / `memory_edges` collections in the embedded
// RedDB store. Running their files in concurrent forks races on the collection
// schema (one path declares `memory_docs` as a table while another writes
// documents → `INVALID_OPERATION: collection 'memory_docs' is declared as
// 'table' and does not allow 'document' writes`). Serial file execution keeps
// the shared-store schema consistent; the speedup that matters here comes from
// excluding the heavy integration suite, not from parallelising the unit gate.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: integrationGlobs(),
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
