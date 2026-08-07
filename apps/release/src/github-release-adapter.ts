import type {
  GithubAttributedOperation,
  GithubClient,
} from "@reddb-io/github";

export interface PublishedReleaseAsset {
  readonly id: number;
  readonly name: string;
}

export interface PublishedRelease {
  readonly id: number;
  readonly tag: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly prerelease: boolean;
  readonly assets: readonly PublishedReleaseAsset[];
  /**
   * Where THIS host wants the Release's assets, as the Release itself answered.
   *
   * Asset upload is the one Release call that does not live on the API host:
   * github.com serves it from `uploads.github.com`, and an Enterprise install
   * answers with its own. A route spelled relative to the client's base URL
   * therefore resolves to a path that exists nowhere and comes back 404. The
   * environment is the source of truth for its own address, so the uploader
   * reads it here rather than reconstructing it.
   */
  readonly uploadUrl: string;
}

export interface CreateReleaseInput {
  readonly tag: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
  readonly prerelease: boolean;
}

export interface UploadReleaseAssetInput {
  readonly releaseId: number;
  /** The owning Release's `uploadUrl` — see {@link PublishedRelease.uploadUrl}. */
  readonly uploadUrl: string;
  readonly name: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

/** The release engine's complete GitHub boundary. */
export interface GithubReleaseAdapter {
  findByTag(tag: string): Promise<PublishedRelease | null>;
  create(input: CreateReleaseInput): Promise<PublishedRelease>;
  uploadAsset(input: UploadReleaseAssetInput): Promise<void>;
}

export interface VersionPullRequestInput {
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
}

export interface VersionPullRequest {
  readonly number: number;
  readonly body: string;
  readonly headCommit: string;
  readonly merged: boolean;
  readonly mergeCommit: string | null;
}

export interface ReleaseEngineGithub extends GithubReleaseAdapter {
  upsertVersionPullRequest(
    input: VersionPullRequestInput,
  ): Promise<{ readonly number: number; readonly created: boolean }>;
  findVersionPullRequest(number: number): Promise<VersionPullRequest | null>;
}

export interface CreateGithubReleaseAdapterOptions {
  readonly client: GithubClient;
  readonly owner: string;
  readonly repository: string;
  readonly actor?: string;
}

const RELEASE_READ: GithubAttributedOperation = {
  key: "release view",
  budget: "rest",
};
const RELEASE_CREATE: GithubAttributedOperation = {
  key: "release create",
  budget: "rest",
};
const RELEASE_ASSET_UPLOAD: GithubAttributedOperation = {
  key: "release asset upload",
  budget: "rest",
};
const VERSION_PR_LIST: GithubAttributedOperation = {
  key: "release version-pr list",
  budget: "rest",
};
const VERSION_PR_CREATE: GithubAttributedOperation = {
  key: "release version-pr create",
  budget: "rest",
};
const VERSION_PR_UPDATE: GithubAttributedOperation = {
  key: "release version-pr update",
  budget: "rest",
};
const VERSION_PR_VIEW: GithubAttributedOperation = {
  key: "release version-pr view",
  budget: "rest",
};

/**
 * Adapt Version-PR and Release REST calls onto the house GitHub client so
 * retries, credentials, and durable attribution stay at one transport boundary.
 */
export function createGithubReleaseAdapter(
  options: CreateGithubReleaseAdapterOptions,
): ReleaseEngineGithub {
  const owner = required(options.owner, "GitHub owner");
  const repository = required(options.repository, "GitHub repository");
  const actor = options.actor ?? "release-engine";
  const repositoryKey = `${owner}/${repository}`;

  return {
    async upsertVersionPullRequest(input) {
      const answer = await options.client.conditionalRest<unknown>({
        cacheKey: `release-version-pr-list:${repositoryKey}:${input.base}:${input.head}`,
        route: "GET /repos/{owner}/{repo}/pulls",
        parameters: {
          owner,
          repo: repository,
          state: "open",
          base: input.base,
          head: `${owner}:${input.head}`,
          per_page: 2,
        },
        operation: VERSION_PR_LIST,
        actor,
      });
      const existing = pullRequestList(answer.data);
      if (existing.length > 1) {
        throw new Error(`repository has multiple open Version PRs for ${input.head}`);
      }
      if (existing.length === 1) {
        const pullRequest = existing[0]!;
        const updated = await options.client.conditionalRest<unknown>({
          cacheKey: `release-version-pr-update:${repositoryKey}:${pullRequest.number}`,
          route: "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
          parameters: {
            owner,
            repo: repository,
            pull_number: pullRequest.number,
            title: input.title,
            body: input.body,
          },
          operation: VERSION_PR_UPDATE,
          actor,
        });
        return { number: pullRequestFrom(updated.data).number, created: false };
      }

      const created = await options.client.conditionalRest<unknown>({
        cacheKey: `release-version-pr-create:${repositoryKey}:${input.head}`,
        route: "POST /repos/{owner}/{repo}/pulls",
        parameters: {
          owner,
          repo: repository,
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        },
        operation: VERSION_PR_CREATE,
        actor,
      });
      return { number: pullRequestFrom(created.data).number, created: true };
    },

    async findVersionPullRequest(number) {
      try {
        const answer = await options.client.conditionalRest<unknown>({
          cacheKey: `release-version-pr:${repositoryKey}:${number}`,
          route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
          parameters: { owner, repo: repository, pull_number: number },
          operation: VERSION_PR_VIEW,
          actor,
        });
        return pullRequestFrom(answer.data);
      } catch (error) {
        if (httpStatus(error) === 404) return null;
        throw error;
      }
    },

    async findByTag(tag): Promise<PublishedRelease | null> {
      try {
        const answer = await options.client.conditionalRest<unknown>({
          cacheKey: `release:${repositoryKey}:${tag}`,
          route: "GET /repos/{owner}/{repo}/releases/tags/{tag}",
          parameters: { owner, repo: repository, tag },
          operation: RELEASE_READ,
          actor,
        });
        return releaseFrom(answer.data);
      } catch (error) {
        if (httpStatus(error) === 404) return null;
        throw error;
      }
    },

    async create(input): Promise<PublishedRelease> {
      const answer = await options.client.conditionalRest<unknown>({
        cacheKey: `release-create:${repositoryKey}:${input.tag}`,
        route: "POST /repos/{owner}/{repo}/releases",
        parameters: {
          owner,
          repo: repository,
          tag_name: input.tag,
          target_commitish: input.targetCommitish,
          name: input.name,
          body: input.body,
          draft: false,
          prerelease: input.prerelease,
        },
        operation: RELEASE_CREATE,
        actor,
      });
      return releaseFrom(answer.data);
    },

    async uploadAsset(input): Promise<void> {
      await options.client.conditionalRest<unknown>({
        cacheKey: `release-asset:${repositoryKey}:${input.releaseId}:${input.name}`,
        route: assetUploadRoute(input.uploadUrl),
        parameters: {
          name: input.name,
          data: input.data,
          headers: {
            "content-type": input.contentType,
            "content-length": input.data.byteLength,
          },
        },
        operation: RELEASE_ASSET_UPLOAD,
        actor,
      });
    },
  };
}

function pullRequestList(value: unknown): Array<{ readonly number: number }> {
  if (!Array.isArray(value)) throw new Error("GitHub returned an invalid Version PR list");
  return value.map((item) => {
    if (!isRecord(item) || !positiveInteger(item.number)) {
      throw new Error("GitHub returned an invalid Version PR list");
    }
    return { number: item.number };
  });
}

function pullRequestFrom(value: unknown): VersionPullRequest {
  if (!isRecord(value) || !positiveInteger(value.number) || !isRecord(value.head)) {
    throw new Error("GitHub returned an invalid Version PR payload");
  }
  if (typeof value.body !== "string" || typeof value.head.sha !== "string" ||
      typeof value.merged !== "boolean") {
    throw new Error("GitHub returned an invalid Version PR payload");
  }
  const mergeCommit = value.merge_commit_sha;
  if (mergeCommit !== null && typeof mergeCommit !== "string") {
    throw new Error("GitHub returned an invalid Version PR merge commit");
  }
  return {
    number: value.number,
    body: value.body,
    headCommit: value.head.sha,
    merged: value.merged,
    mergeCommit,
  };
}

function releaseFrom(value: unknown): PublishedRelease {
  if (!isRecord(value) || !positiveInteger(value.id)) {
    throw new Error("GitHub returned an invalid Release payload");
  }
  if (typeof value.prerelease !== "boolean") {
    throw new Error("GitHub returned an invalid Release prerelease marking");
  }
  const assets = Array.isArray(value.assets)
    ? value.assets.map((asset): PublishedReleaseAsset => {
        if (!isRecord(asset) || !positiveInteger(asset.id) || typeof asset.name !== "string") {
          throw new Error("GitHub returned an invalid Release asset payload");
        }
        return { id: asset.id, name: asset.name };
      })
    : [];
  return {
    id: value.id,
    tag: stringField(value, "tag_name"),
    targetCommitish: stringField(value, "target_commitish"),
    name: stringField(value, "name"),
    body: stringField(value, "body"),
    prerelease: value.prerelease,
    assets,
    uploadUrl: stringField(value, "upload_url"),
  };
}

/**
 * The upload endpoint from a Release's `upload_url` RFC 6570 template.
 *
 * GitHub answers `https://uploads.github.com/…/assets{?name,label}`. The
 * variable list is dropped and re-declared as `{?name}`: the caller supplies a
 * name and never a label, and leaving `label` in the template would make the
 * client expand a parameter nothing passes.
 */
function assetUploadRoute(uploadUrl: string): string {
  const endpoint = uploadUrl.split("{")[0] ?? "";
  if (!/^https?:\/\/\S+\/assets$/.test(endpoint)) {
    throw new Error(`GitHub returned an unusable Release upload_url: ${uploadUrl}`);
  }
  return `POST ${endpoint}{?name}`;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`GitHub Release payload has no ${key}`);
  return field;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${label} must not be empty`);
  return normalized;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function httpStatus(error: unknown): number | undefined {
  return isRecord(error) && typeof error.status === "number" ? error.status : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
