import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { WrittenReleaseArtifacts } from "./release-artifacts.js";
import type {
  GithubReleaseAdapter,
  PublishedRelease,
} from "./github-release-adapter.js";

export interface PublishReleaseInput {
  readonly repoRoot: string;
  readonly version: string;
  readonly artifacts: WrittenReleaseArtifacts;
  readonly github: GithubReleaseAdapter;
  readonly remote?: string;
  readonly commit?: string;
  readonly prerelease?: boolean;
}

export interface PublishReleaseResult {
  readonly commit: string;
  readonly tag: string;
  readonly tagCreated: boolean;
  readonly releaseId: number;
  readonly releaseCreated: boolean;
  readonly uploadedAssets: readonly string[];
}

interface ManifestAsset {
  readonly name: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/**
 * Converge git and GitHub on one published Release. Every completed step is
 * discovered before it is attempted, so a process can resume at any boundary.
 */
export async function publishRelease(
  input: PublishReleaseInput,
): Promise<PublishReleaseResult> {
  const version = input.version.trim();
  if (version === "") throw new Error("release version must not be empty");
  const tag = `v${version}`;
  const remote = input.remote ?? "origin";
  assertTagName(input.repoRoot, tag);
  const commit = input.commit === undefined
    ? git(input.repoRoot, ["rev-parse", "HEAD"])
    : git(input.repoRoot, ["rev-parse", "--verify", `${input.commit}^{commit}`]);
  const prerelease = input.prerelease ?? false;
  const tagCreated = ensureRemoteTag(input.repoRoot, remote, tag, commit);
  const notes = readFileSync(input.artifacts.notesPath, "utf8");
  const assets: readonly ManifestAsset[] = [
    {
      name: "release-manifest.json",
      contentType: "application/json",
      data: readFileSync(input.artifacts.jsonManifestPath),
    },
    {
      name: "release-manifest.toon",
      contentType: "text/plain; charset=utf-8",
      data: readFileSync(input.artifacts.toonManifestPath),
    },
  ];

  let release = await input.github.findByTag(tag);
  let releaseCreated = false;
  if (release === null) {
    try {
      release = await input.github.create({
        tag,
        targetCommitish: commit,
        name: tag,
        body: notes,
        prerelease,
      });
      releaseCreated = true;
    } catch (error) {
      // The create may have committed at GitHub before its response was lost,
      // or another publisher may have won the same race. Re-observe once.
      release = await input.github.findByTag(tag);
      if (release === null) throw error;
    }
  }
  assertReleaseMatches(release, { tag, commit, notes, prerelease });

  const attached = uniqueAssetNames(release);
  const uploadedAssets: string[] = [];
  for (const asset of assets) {
    if (attached.has(asset.name)) continue;
    try {
      await input.github.uploadAsset({
        releaseId: release.id,
        uploadUrl: release.uploadUrl,
        name: asset.name,
        contentType: asset.contentType,
        data: asset.data,
      });
      attached.add(asset.name);
      uploadedAssets.push(asset.name);
    } catch (error) {
      // Upload responses can fail after GitHub persisted the bytes. A fresh
      // Release read decides whether retrying would create a duplicate.
      const observed = await input.github.findByTag(tag);
      if (observed === null || !observed.assets.some(({ name }) => name === asset.name)) {
        throw error;
      }
      assertReleaseMatches(observed, { tag, commit, notes, prerelease });
      attached.add(asset.name);
      uploadedAssets.push(asset.name);
    }
  }

  return {
    commit,
    tag,
    tagCreated,
    releaseId: release.id,
    releaseCreated,
    uploadedAssets,
  };
}

function ensureRemoteTag(
  repoRoot: string,
  remote: string,
  tag: string,
  commit: string,
): boolean {
  const remoteCommit = readRemoteTag(repoRoot, remote, tag);
  if (remoteCommit !== null) {
    assertSameTagTarget(tag, remoteCommit, commit, "remote");
    return false;
  }

  const local = tryGit(repoRoot, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  if (local.ok) assertSameTagTarget(tag, local.stdout, commit, "local");
  else git(repoRoot, ["tag", tag, commit]);

  const pushed = tryGit(repoRoot, [
    "push",
    remote,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  if (pushed.ok) return true;

  // A concurrent publisher can make the non-force push lose after our first
  // read. Accept only the exact commit; every other rejection stays fatal.
  const raced = readRemoteTag(repoRoot, remote, tag);
  if (raced !== null) {
    assertSameTagTarget(tag, raced, commit, "remote");
    return false;
  }
  throw gitFailure(["push", remote, `refs/tags/${tag}`], pushed.stderr);
}

function readRemoteTag(repoRoot: string, remote: string, tag: string): string | null {
  const result = tryGit(repoRoot, ["ls-remote", "--refs", remote, `refs/tags/${tag}`]);
  if (!result.ok) throw gitFailure(["ls-remote", remote, `refs/tags/${tag}`], result.stderr);
  if (result.stdout === "") return null;
  const rows = result.stdout.split("\n").filter(Boolean);
  if (rows.length !== 1) throw new Error(`remote returned multiple refs for release tag ${tag}`);
  const [commit] = rows[0]!.split(/\s+/, 1);
  return commit ?? null;
}

function assertTagName(repoRoot: string, tag: string): void {
  const result = tryGit(repoRoot, ["check-ref-format", `refs/tags/${tag}`]);
  if (!result.ok) throw new Error(`invalid release tag: ${tag}`);
}

function assertSameTagTarget(
  tag: string,
  actual: string,
  expected: string,
  location: "local" | "remote",
): void {
  if (actual === expected) return;
  throw new Error(
    `${location} release tag ${tag} points to ${actual}, expected merged revision ${expected}`,
  );
}

function assertReleaseMatches(
  release: PublishedRelease,
  expected: {
    readonly tag: string;
    readonly commit: string;
    readonly notes: string;
    readonly prerelease: boolean;
  },
): void {
  if (release.tag !== expected.tag) {
    throw new Error(`GitHub Release tag mismatch: ${release.tag} != ${expected.tag}`);
  }
  if (release.targetCommitish !== expected.commit) {
    throw new Error(
      `GitHub Release ${expected.tag} targets ${release.targetCommitish}, expected ${expected.commit}`,
    );
  }
  if (release.name !== expected.tag) {
    throw new Error(`GitHub Release ${expected.tag} has unexpected name ${release.name}`);
  }
  if (release.body !== expected.notes) {
    throw new Error(`GitHub Release ${expected.tag} notes do not match the rendered notes`);
  }
  if (release.prerelease !== expected.prerelease) {
    throw new Error(`GitHub Release ${expected.tag} has unexpected prerelease marking`);
  }
}

function uniqueAssetNames(release: PublishedRelease): Set<string> {
  const names = new Set<string>();
  for (const asset of release.assets) {
    if (names.has(asset.name)) {
      throw new Error(`GitHub Release ${release.tag} has duplicate asset ${asset.name}`);
    }
    names.add(asset.name);
  }
  return names;
}

function git(repoRoot: string, args: readonly string[]): string {
  const result = tryGit(repoRoot, args);
  if (!result.ok) throw gitFailure(args, result.stderr);
  return result.stdout;
}

function tryGit(
  repoRoot: string,
  args: readonly string[],
): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return {
    ok: result.status === 0 && result.error === undefined,
    stdout: result.stdout.trim(),
    stderr: result.error?.message ?? result.stderr.trim(),
  };
}

function gitFailure(args: readonly string[], detail: string): Error {
  return new Error(`git ${args[0] ?? "command"} failed${detail === "" ? "" : `: ${detail}`}`);
}
