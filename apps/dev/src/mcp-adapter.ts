// mcp-adapter — the public façade over `./mcp/`.
//
// A barrel is a legitimate front door when what stands behind it is several
// modules. It was not one when it forwarded to a single 2070-line file: the
// reader looking for where something lives found a file that only points
// elsewhere, and the accumulation the split was meant to end kept accumulating
// one directory down. The file-size ratchet is what keeps that from returning.
export * from "./mcp/operations.js";
export * from "./mcp/handlers.js";
export * from "./mcp/project.js";
export * from "./mcp/vitals.js";
export * from "./mcp/queue.js";
export * from "./mcp/events.js";
export * from "./mcp/dependencies.js";
