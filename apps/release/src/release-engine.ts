import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangesetQueue, QueuedChange } from "./changeset-queue.js";
import { readChangesetQueue } from "./changeset-queue.js";
import type {
  ReleaseEngineGithub,
  VersionPullRequest,
  VersionPullRequestInput,
} from "./github-release-adapter.js";
import { writeReleaseArtifacts } from "./release-artifacts.js";
import { publishRelease } from "./release-publication.js";
import { computeNextVersion, type ReleaseClock } from "./version-core.js";
import { readReleaseConfig, writeVersionSurfaces } from "./version-surfaces.js";

export const RELEASE_BOT_AUTHOR = "red-skills-release[bot]";
export const VERSION_PR_BRANCH = "red-release/version-pr";

export type { ReleaseEngineGithub, VersionPullRequest, VersionPullRequestInput };

export type ReleaseEngineEvent =
  | { readonly kind: "push"; readonly commitAuthor: string }
  | { readonly kind: "version-pr-merged"; readonly number: number };

export interface RunReleaseEngineInput {
  readonly repoRoot: string;
  readonly event: ReleaseEngineEvent;
  readonly github: ReleaseEngineGithub;
  readonly clock: ReleaseClock;
  readonly remote?: string;
  readonly baseBranch?: string;
  readonly date?: string;
}

export type ReleaseEngineResult =
  | {
      readonly kind: "version-pr";
      readonly action: "created" | "updated";
      readonly number: number;
      readonly version: string;
    }
  | {
      readonly kind: "published";
      readonly version: string;
      readonly tag: string;
      readonly commit: string;
    }
  | { readonly kind: "ignored"; readonly reason: "release-bump" }
  | { readonly kind: "idle"; readonly reason: "empty-queue" };

interface ReleasePlan {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly QueuedChange[];
}

const PLAN_MARKER = "red-release-plan:v1";

/** Converge one repository release event according to its configured trigger. */
export async function runReleaseEngine(
  input: RunReleaseEngineInput,
): Promise<ReleaseEngineResult> {
  if (input.event.kind === "push" && input.event.commitAuthor === RELEASE_BOT_AUTHOR) {
    return { kind: "ignored", reason: "release-bump" };
  }
  const config = readReleaseConfig(input.repoRoot);
  if (input.event.kind === "version-pr-merged") {
    return publishMergedVersionPullRequest(input, input.event.number);
  }

  const queue = readChangesetQueue(join(input.repoRoot, ".changeset"));
  if (queue.changes.length === 0) return { kind: "idle", reason: "empty-queue" };
  const plan = releasePlan(input, queue, config.scheme);
  if (config.trigger === "auto") {
    createReleaseCommit(input.repoRoot, plan, queue);
    git(
      input.repoRoot,
      "push", input.remote ?? "origin",
      `HEAD:refs/heads/${input.baseBranch ?? "main"}`,
    );
    return publishPlan(input, plan);
  }
  maintainVersionBranch(input, plan, queue);
  const pullRequest = await input.github.upsertVersionPullRequest({
    base: input.baseBranch ?? "main",
    head: VERSION_PR_BRANCH,
    title: `chore(release): ${plan.version}`,
    body: renderVersionPullRequestBody(plan),
  });
  return {
    kind: "version-pr",
    action: pullRequest.created ? "created" : "updated",
    number: pullRequest.number,
    version: plan.version,
  };
}

function releasePlan(
  input: RunReleaseEngineInput,
  queue: ChangesetQueue,
  scheme: "semver" | "calver",
): ReleasePlan {
  return {
    version: computeNextVersion({
      currentVersion: currentVersion(input.repoRoot),
      pending: queue.pending,
      scheme,
      clock: input.clock,
    }),
    date: input.date ?? new Date().toISOString().slice(0, 10),
    changes: queue.changes,
  };
}

function maintainVersionBranch(
  input: RunReleaseEngineInput,
  plan: ReleasePlan,
  queue: ChangesetQueue,
): void {
  const originalBranch = git(input.repoRoot, "branch", "--show-current");
  if (originalBranch === "") throw new Error("release engine requires a named checkout branch");
  const baseCommit = git(input.repoRoot, "rev-parse", "HEAD");
  try {
    git(input.repoRoot, "checkout", "-B", VERSION_PR_BRANCH, baseCommit);
    createReleaseCommit(input.repoRoot, plan, queue);
    git(
      input.repoRoot,
      "push", "--force-with-lease", input.remote ?? "origin",
      `HEAD:refs/heads/${VERSION_PR_BRANCH}`,
    );
  } finally {
    git(input.repoRoot, "checkout", originalBranch);
  }
}

function createReleaseCommit(repoRoot: string, plan: ReleasePlan, queue: ChangesetQueue): string {
  writeVersionSurfaces({ repoRoot, nextVersion: plan.version });
  for (const change of queue.changes) {
    rmSync(join(repoRoot, ".changeset", change.file));
  }
  git(repoRoot, "add", "--all");
  git(
    repoRoot,
    "-c", `user.name=${RELEASE_BOT_AUTHOR}`,
    "-c", "user.email=release-bot@example.invalid",
    "commit", "-m", `chore(release): ${plan.version}`,
  );
  return git(repoRoot, "rev-parse", "HEAD");
}

async function publishMergedVersionPullRequest(
  input: RunReleaseEngineInput,
  number: number,
): Promise<ReleaseEngineResult> {
  const pullRequest = await input.github.findVersionPullRequest(number);
  if (pullRequest === null) throw new Error(`Version PR #${number} was not found`);
  if (!pullRequest.merged || pullRequest.mergeCommit === null) {
    throw new Error(`Version PR #${number} has not merged`);
  }
  const commit = git(input.repoRoot, "rev-parse", "HEAD");
  if (commit !== pullRequest.mergeCommit) {
    throw new Error(
      `Version PR #${number} merged as ${pullRequest.mergeCommit}, but checkout is ${commit}`,
    );
  }
  const plan = parseVersionPullRequestBody(pullRequest.body);
  return publishPlan(input, plan);
}

async function publishPlan(
  input: RunReleaseEngineInput,
  plan: ReleasePlan,
): Promise<ReleaseEngineResult> {
  const artifactDirectory = mkdtempSync(join(tmpdir(), "red-release-artifacts-"));
  try {
    const artifacts = writeReleaseArtifacts({
      outputDirectory: join(artifactDirectory, "release"),
      version: plan.version,
      date: plan.date,
      changes: plan.changes.map((change) => ({
        ...change,
        authors: [],
        pullRequests: [],
      })),
    });
    const published = await publishRelease({
      repoRoot: input.repoRoot,
      version: plan.version,
      artifacts,
      github: input.github,
      remote: input.remote,
    });
    return {
      kind: "published",
      version: plan.version,
      tag: published.tag,
      commit: published.commit,
    };
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
}

function renderVersionPullRequestBody(plan: ReleasePlan): string {
  const notes = writeReleaseArtifactsPreview(plan);
  const encoded = Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
  return `${notes}\n<!-- ${PLAN_MARKER} ${encoded} -->\n`;
}

function writeReleaseArtifactsPreview(plan: ReleasePlan): string {
  const directory = mkdtempSync(join(tmpdir(), "red-release-preview-"));
  try {
    const artifacts = writeReleaseArtifacts({
      outputDirectory: join(directory, "release"),
      version: plan.version,
      date: plan.date,
      changes: plan.changes.map((change) => ({
        ...change,
        authors: [],
        pullRequests: [],
      })),
    });
    return readFileSync(artifacts.notesPath, "utf8").trimEnd();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function parseVersionPullRequestBody(body: string): ReleasePlan {
  const match = new RegExp(`<!-- ${PLAN_MARKER} ([A-Za-z0-9_-]+) -->`).exec(body);
  if (match === null) throw new Error("Version PR has no release plan metadata");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error(`Version PR has invalid release plan metadata: ${errorMessage(error)}`);
  }
  if (!isReleasePlan(value)) throw new Error("Version PR has invalid release plan metadata");
  return value;
}

function currentVersion(repoRoot: string): string {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new Error(`cannot read current version from package.json: ${errorMessage(error)}`);
  }
  if (!isRecord(manifest) || typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("cannot read current version: package.json has no version");
  }
  return manifest.version;
}

function isReleasePlan(value: unknown): value is ReleasePlan {
  return isRecord(value) && typeof value.version === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(value.date)) && Array.isArray(value.changes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim();
  } catch (error) {
    const detail = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`git ${args[0] ?? "command"} failed${detail === "" ? "" : `: ${detail}`}`);
  }
}
