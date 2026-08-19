import { describe, expect, it } from "vitest";
import {
  defaultSandboxImageName,
  formatSandboxImageBuildCommand,
  resolveSandboxImageName,
} from "../src/core/execution/sandbox-image.js";

const REPO_ROOT = "/srv/checkouts/red-skills";
// The worker worktree red-castle runs in — the path whose LAST segment used
// to become the image tag (`sandcastle:2338`, issue #2340).
const ATTEMPT_WORKTREE =
  `${REPO_ROOT}/.red/tmp/workers/wHKWN/2340/worktree`;

describe("defaultSandboxImageName", () => {
  it("derives a repo-level tag from the checkout directory name", () => {
    expect(defaultSandboxImageName(REPO_ROOT)).toBe("sandcastle:red-skills");
  });

  it("sanitises segments that are not legal image-tag characters", () => {
    expect(defaultSandboxImageName("/srv/My Repo!")).toBe("sandcastle:my-repo-");
  });

  it("tolerates a trailing separator and an empty path", () => {
    expect(defaultSandboxImageName("/srv/red-skills/")).toBe("sandcastle:red-skills");
    expect(defaultSandboxImageName("")).toBe("sandcastle:local");
  });
});

describe("resolveSandboxImageName", () => {
  // The #2340 regression: red-castle tagged the image off its own cwd — the
  // per-attempt worktree — producing `sandcastle:<issue>`, an image that can
  // never be prebuilt. The resolved name must be pinned to the repo root.
  it("pins the repo-root tag for a worker-attempt worktree path", () => {
    expect(resolveSandboxImageName({ repoRoot: REPO_ROOT })).toBe("sandcastle:red-skills");
    expect(defaultSandboxImageName(ATTEMPT_WORKTREE)).not.toBe(
      resolveSandboxImageName({ repoRoot: REPO_ROOT }),
    );
  });

  it("prefers the configured image over the repo-level default", () => {
    expect(resolveSandboxImageName({ repoRoot: REPO_ROOT, configured: "ghcr.io/acme/afk:v3" })).toBe(
      "ghcr.io/acme/afk:v3",
    );
  });

  it("prefers the env override over both config and default", () => {
    expect(
      resolveSandboxImageName({
        repoRoot: REPO_ROOT,
        configured: "ghcr.io/acme/afk:v3",
        envOverride: "ghcr.io/acme/afk:pinned",
      }),
    ).toBe("ghcr.io/acme/afk:pinned");
  });

  it("ignores blank config / env values instead of resolving an empty tag", () => {
    expect(resolveSandboxImageName({ repoRoot: REPO_ROOT, configured: "  ", envOverride: "" })).toBe(
      "sandcastle:red-skills",
    );
  });
});

describe("formatSandboxImageBuildCommand", () => {
  it("names the exact build command for the resolved provider and image", () => {
    expect(formatSandboxImageBuildCommand("docker", "sandcastle:red-skills")).toBe(
      "sandcastle docker build-image --image-name sandcastle:red-skills",
    );
    expect(formatSandboxImageBuildCommand("podman", "sandcastle:red-skills")).toBe(
      "sandcastle podman build-image --image-name sandcastle:red-skills",
    );
  });
});
