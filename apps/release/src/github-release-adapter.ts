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
  readonly assets: readonly PublishedReleaseAsset[];
}

export interface CreateReleaseInput {
  readonly tag: string;
  readonly targetCommitish: string;
  readonly name: string;
  readonly body: string;
}

export interface UploadReleaseAssetInput {
  readonly releaseId: number;
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

/**
 * Adapt Release REST calls onto the house GitHub client so retries,
 * credentials, and durable request attribution stay at one transport boundary.
 */
export function createGithubReleaseAdapter(
  options: CreateGithubReleaseAdapterOptions,
): GithubReleaseAdapter {
  const owner = required(options.owner, "GitHub owner");
  const repository = required(options.repository, "GitHub repository");
  const actor = options.actor ?? "release-engine";
  const repositoryKey = `${owner}/${repository}`;

  return {
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
          prerelease: false,
        },
        operation: RELEASE_CREATE,
        actor,
      });
      return releaseFrom(answer.data);
    },

    async uploadAsset(input): Promise<void> {
      await options.client.conditionalRest<unknown>({
        cacheKey: `release-asset:${repositoryKey}:${input.releaseId}:${input.name}`,
        route: "POST /repos/{owner}/{repo}/releases/{release_id}/assets{?name}",
        parameters: {
          owner,
          repo: repository,
          release_id: input.releaseId,
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

function releaseFrom(value: unknown): PublishedRelease {
  if (!isRecord(value) || !positiveInteger(value.id)) {
    throw new Error("GitHub returned an invalid Release payload");
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
    assets,
  };
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
