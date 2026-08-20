// drain-registration-resolve — the checkout half of a registering drain (#4101).
//
// `buildDrainRegistration` is pure and knows nothing about where it runs. This
// is the one place that asks the machine: which repository this checkout is,
// where it stands, and which version a birth should reach for. Kept apart from
// the pure builder so the rule stays testable without a git checkout, and kept
// out of the tool handlers so a tool remains a schema.
import { resolveProjectIdentityForDir } from "@reddb-io/shared/project-identity-resolve.js";
import { DEFAULT_FLEET_WIDTH } from "@reddb-io/shared/default-fleet-width.js";

import { buildDrainRegistration, type DrainRegistration } from "./drain-registration.js";

/**
 * The registration this checkout's drain carries, or `undefined` when the
 * checkout cannot name a repository.
 *
 * **Absent is a real answer.** A directory with no `owner/name` — no git remote
 * and no declared project — cannot state a tracker query, and inventing one
 * would register a project the daemon would then poll for nothing. The drain
 * still records its intent, and the daemon's own warning says nobody will act
 * on it, which is the truth.
 */
export function drainRegistrationFor(
  root: string,
  version: string,
  input: Readonly<Record<string, unknown>> = {},
  resolve = resolveProjectIdentityForDir,
): DrainRegistration | undefined {
  const repo = repositoryOf(root, resolve);
  if (repo == null) return undefined;
  const target = typeof input.target === "number" && Number.isInteger(input.target) && input.target >= 0
    ? input.target
    : DEFAULT_FLEET_WIDTH;
  const runner = typeof input.runner === "string" && input.runner.length > 0 ? input.runner : undefined;
  return buildDrainRegistration({
    repo,
    workspacePath: root,
    target,
    version,
    ...(runner == null ? {} : { runner }),
  });
}

/** `owner/name` for this checkout, or `undefined` when it has no such identity. PURE-ish. */
export function repositoryOf(root: string, resolve = resolveProjectIdentityForDir): string | undefined {
  let name: string;
  try {
    name = resolve(root).name;
  } catch {
    return undefined;
  }
  // A tracker query needs `owner/name`; a bare basename is a checkout nobody
  // can turn into a repository query, and guessing an owner would be worse.
  return /^[^/\s]+\/[^/\s]+$/.test(name) ? name : undefined;
}
