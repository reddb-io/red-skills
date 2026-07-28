import type { ProcessIssueDeps } from "../../../core/process-issue.js";
import * as fsx from "../../../runtime/fs.js";
import type { AfkPaths } from "../../../runtime/wire.js";

/**
 * Filesystem port: the only context it binds is the resolved AFK path set, so a
 * fake `AfkPaths` over a tmpdir exercises it end to end.
 */
export function buildFsPort(paths: AfkPaths): NonNullable<ProcessIssueDeps["fs"]> {
  return {
    ensureAttemptDir: (dir) => fsx.ensureDir(dir),
    writeHandoff: (path, content) => fsx.writeHandoff(path, content),
    readText: (path) => fsx.readText(path),
    // $ITER_DIR/validation.jsonl — the machine-readable feedback sidecar the
    // Memory bridge consumes (SKILL.md §Validation Sidecar).
    writeValidationSidecar: (path, lines) => fsx.writeValidationSidecar(path, lines),
    completionSweep: (issue) => fsx.completionSweep(paths.workersRoot, issue),
  };
}
