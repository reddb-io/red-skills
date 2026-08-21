// drain-registration-resolve — the checkout half of a registering drain (#4101).
//
// `buildDrainRegistration` is pure and knows nothing about where it runs. This
// is the one place that asks the machine: which repository this checkout is,
// where it stands, and which version a birth should reach for. Kept apart from
// the pure builder so the rule stays testable without a git checkout, and kept
// out of the tool handlers so a tool remains a schema.
import { execFileSync } from "node:child_process";

import { resolveProjectIdentityForDir } from "@reddb-io/shared/project-identity-resolve.js";

import { buildDrainRegistration, type DrainRegistration } from "./drain-registration.js";
import { loadConfig, readValidationMoments } from "./config.js";
import {
  declaredStandingDrain,
  resolveDrainRunner,
  resolveDrainTarget,
} from "./standing-drain-declaration.js";
import { afkPaths } from "../runtime/wire/paths.js";

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
  // The caller's words first, the project's declaration second, the governed
  // default last (#4293). Before this, a `drain` with no runner argument dropped
  // the declared one on the floor and the argv carried no `--child-agent` — so
  // the maintainer's declared executor was silently not the one that ran.
  const standing = declaredStandingDrain(root);
  const target = resolveDrainTarget(input.target, standing);
  const runner = resolveDrainRunner(input.runner, standing);
  const declared = declaredGateCommands(root);
  // The operator's harvest budget, carried only when they stated one: a default
  // here would be the daemon inventing a deadline nobody asked for (#4170).
  const budgetMs = typeof input.budget_ms === "number" && Number.isFinite(input.budget_ms) && input.budget_ms > 0
    ? input.budget_ms
    : undefined;
  return buildDrainRegistration({
    repo,
    workspacePath: root,
    target,
    version,
    ...(runner == null ? {} : { runner }),
    ...(trunkBranch(root) == null ? {} : { trunkBranch: trunkBranch(root) }),
    ...(declared.length === 0 ? {} : { validationCommands: declared }),
    ...(budgetMs == null ? {} : { budgetMs }),
  });
}

/**
 * The whole drain input this checkout carries: the caller's words, completed by
 * the project's declaration.
 *
 * ONE namer for the resolution. The registration's `argv` and its `target` and
 * the control call's own `runner` and `target` describe the same decision, so a
 * seam that resolved the registration and left the control pair raw would put
 * two answers on one wire. Keys stay OMITTED rather than set to `undefined`: an
 * absent runner is the governed default, and a null on the wire is a caller
 * stating one.
 */
export function drainInputFor(
  root: string,
  version: string,
  input: Readonly<Record<string, unknown>> = {},
  resolve = resolveProjectIdentityForDir,
): Record<string, unknown> {
  const standing = declaredStandingDrain(root);
  const runner = resolveDrainRunner(input.runner, standing);
  const registration = drainRegistrationFor(root, version, input, resolve);
  return {
    ...input,
    ...(runner == null ? {} : { runner }),
    target: resolveDrainTarget(input.target, standing),
    ...(registration == null ? {} : { registration }),
  };
}

/**
 * The repo's declared local gate, in schedule order (#4166).
 *
 * `post_done` then `landing`: the Worker's gate sits between DONE and the
 * publish, which is exactly those two moments back to back. `iteration` is
 * the inner agent's while-writing loop and deliberately not repeated here.
 * A repo that declared nothing gets an empty answer — the Worker then falls
 * back to its improvised cone, which stays legal for undeclared repos.
 */
export function declaredGateCommands(root: string): string[] {
  try {
    const moments = readValidationMoments(loadConfig(afkPaths(root).configPath, { warn: () => undefined }));
    return [...(moments.post_done ?? []), ...(moments.landing ?? [])];
  } catch {
    return [];
  }
}

/** The branch `origin/HEAD` points at, or `undefined` when git cannot say. */
export function trunkBranch(root: string): string | undefined {
  try {
    const head = execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    const branch = head.split("/").pop();
    return branch == null || branch === "" ? undefined : branch;
  } catch {
    // `main` is the builder's own fallback; inventing one here would decide twice.
    return undefined;
  }
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
