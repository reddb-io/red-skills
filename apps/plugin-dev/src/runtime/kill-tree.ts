// Compatibility shim: the process-tree killer belongs to the shared runtime so
// host daemons and the dev orchestrator execute the same escalation contract.
export * from "@reddb-io/shared/kill-tree.js";
