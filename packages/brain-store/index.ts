// @reddb-io/brain-store — the brain's engine, held once per host (ADR 0152).
//
// Brain used to be a heavy MCP that opened its own RedDB in every session
// process, so the engine sat inside the plugin app that mounted it. Once the
// daemon holds the handle, two runtimes need the same engine — the `brain` CLI
// an operator runs in a checkout, and `redskilled`, which serves every session
// on the machine from `~/.red/brain`. Code two runtimes share lives in a
// package; that is the whole reason this one exists.
//
// What is NOT here is the adapter: `rs_brain` publishes tool schemas and
// forwards them over ACP, and it must be startable once per session without
// paying for any of this (ADR 0147 rule 2).
export * from "./auto-linker.js";
export * from "./brain-act.js";
export * from "./channel-bridge.js";
export * from "./config.js";
export * from "./hash.js";
export * from "./kpi-query.js";
export * from "./model-tier-bandit.js";
export * from "./schema.js";
export * from "./store.js";
