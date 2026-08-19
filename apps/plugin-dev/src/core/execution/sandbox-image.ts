import type { SandboxMode } from "./runtime.js";

/**
 * Container-image naming for AFK's isolation path (issue #2340).
 *
 * red-castle's providers fall back to `defaultImageName(hostRepoPath)` when no
 * image is configured, and AFK hands them the PER-ATTEMPT worktree as their
 * cwd — so the tag came out as `sandcastle:<issue-number>`, an image nobody can
 * prebuild. Every untrusted-author issue (which the sandbox policy forces into
 * container isolation) therefore crashed on a missing image inside a minute.
 *
 * AFK resolves the image name itself instead, off the REPO ROOT, and passes it
 * explicitly to the provider — so the tag is stable across attempts, issues,
 * and workers, and an operator can build it once.
 */

/** `sandcastle:<repo-dir-name>`, sanitised for image-tag rules. Mirrors
 * red-castle's own `defaultImageName` so an image built with the plain
 * `sandcastle docker build-image` in the checkout still matches. */
export function defaultSandboxImageName(repoRoot: string): string {
  const dirName = repoRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "local";
  const sanitized = dirName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  return `sandcastle:${sanitized || "local"}`;
}

export interface SandboxImageInput {
  /** Repo checkout root — NOT the per-attempt worktree. */
  repoRoot: string;
  /** `afk.sandbox_image` from `.red/config.yaml`. */
  configured?: string;
  /** `RED_AFK_SANDBOX_IMAGE`, so CI/E2E can pin without editing the config. */
  envOverride?: string;
}

/** Precedence: `RED_AFK_SANDBOX_IMAGE` > `afk.sandbox_image` > repo-level
 * default. Blank values in either source fall through, so a stray empty key can
 * never resolve to an unbuildable empty tag. */
export function resolveSandboxImageName(input: SandboxImageInput): string {
  const env = (input.envOverride ?? "").trim();
  if (env) return env;
  const configured = (input.configured ?? "").trim();
  if (configured) return configured;
  return defaultSandboxImageName(input.repoRoot);
}

/** The exact command an operator must run to make a missing image exist — the
 * actionable half of the park message, so an untrusted-author issue never burns
 * its retry budget on a bare "image not found" crash. */
export function formatSandboxImageBuildCommand(
  mode: Exclude<SandboxMode, "none">,
  image: string,
): string {
  return `sandcastle ${mode} build-image --image-name ${image}`;
}
