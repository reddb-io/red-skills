// @reddb-io/protocol-acp — the shared RedSkills ACP wire (ADR 0148).
//
// One package the daemon, the Worker and the stateless adapters all import, so
// the two ends of any RedSkills socket negotiate against the same answers:
// ACP v1/v2 compat and draft-revision gating, the RedSkills wire major, the
// local Unix-socket / Named Pipe transport, and the `_redskills/*` methods.
export * from "./brain.js";
export * from "./compat.js";
export * from "./dual-dialect-stream.js";
export * from "./endpoint.js";
export * from "./github-request.js";
export * from "./github-write.js";
export * from "./go-dispatch.js";
export * from "./memory.js";
export * from "./methods.js";
export * from "./publication.js";
export * from "./session-recovery.js";
export * from "./ticket.js";
export * from "./transport.js";
export * from "./worktree.js";
