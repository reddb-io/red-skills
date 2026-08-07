import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGithubClient,
  type GithubRequestFetch,
} from "@reddb-io/github";
import { afterEach, describe, expect, it } from "vitest";
import { createGithubReleaseAdapter } from "../src/github-release-adapter.js";
import { writeReleaseArtifacts } from "../src/release-artifacts.js";
import { publishRelease } from "../src/release-publication.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release publication", () => {
  it("pushes the version tag and publishes notes with both manifest assets", async () => {
    const fixture = publicationFixture();

    const result = await fixture.publish();

    expect(result).toEqual({
      commit: fixture.head,
      tag: "v2.0.0",
      tagCreated: true,
      releaseId: 1,
      releaseCreated: true,
      uploadedAssets: ["release-manifest.json", "release-manifest.toon"],
    });
    expect(git(fixture.remote, "show-ref", "--hash", "refs/tags/v2.0.0")).toBe(fixture.head);
    expect(fixture.api.release).toMatchObject({
      tag_name: "v2.0.0",
      target_commitish: fixture.head,
      name: "v2.0.0",
      body: readFileSync(fixture.artifacts.notesPath, "utf8"),
      draft: false,
      prerelease: false,
    });
    expect(fixture.api.assets.map(({ name, data }) => ({ name, data }))).toEqual([
      {
        name: "release-manifest.json",
        data: readFileSync(fixture.artifacts.jsonManifestPath, "utf8"),
      },
      {
        name: "release-manifest.toon",
        data: readFileSync(fixture.artifacts.toonManifestPath, "utf8"),
      },
    ]);
  });

  it("converges without another tag, Release, or asset attachment", async () => {
    const fixture = publicationFixture();
    await fixture.publish();

    const repeated = await fixture.publish();

    expect(repeated).toEqual({
      commit: fixture.head,
      tag: "v2.0.0",
      tagCreated: false,
      releaseId: 1,
      releaseCreated: false,
      uploadedAssets: [],
    });
    expect(fixture.api.createCalls).toBe(1);
    expect(fixture.api.successfulUploads).toEqual([
      "release-manifest.json",
      "release-manifest.toon",
    ]);
    expect(git(fixture.remote, "show-ref", "--hash", "refs/tags/v2.0.0")).toBe(fixture.head);
  });

  it("resumes after a mid-publication failure without duplicating the completed asset", async () => {
    const fixture = publicationFixture({ failOnceFor: "release-manifest.toon" });

    await expect(fixture.publish()).rejects.toThrow("fixture upload interruption");
    expect(git(fixture.remote, "show-ref", "--hash", "refs/tags/v2.0.0")).toBe(fixture.head);
    expect(fixture.api.release).not.toBeNull();
    expect(fixture.api.successfulUploads).toEqual(["release-manifest.json"]);

    const resumed = await fixture.publish();

    expect(resumed).toMatchObject({
      tagCreated: false,
      releaseCreated: false,
      uploadedAssets: ["release-manifest.toon"],
    });
    expect(fixture.api.createCalls).toBe(1);
    expect(fixture.api.successfulUploads).toEqual([
      "release-manifest.json",
      "release-manifest.toon",
    ]);
    expect(fixture.api.assets.map(({ name }) => name)).toEqual([
      "release-manifest.json",
      "release-manifest.toon",
    ]);
  });
});

function publicationFixture(options: { readonly failOnceFor?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "red-release-publication-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  git(root, "init", "--bare", remote);
  git(root, "init", "--initial-branch=main", repository);
  git(repository, "config", "user.name", "Release Fixture");
  git(repository, "config", "user.email", "release-fixture@example.invalid");
  writeFileSync(join(repository, "package.json"), '{"version":"2.0.0"}\n');
  git(repository, "add", "package.json");
  git(repository, "commit", "-m", "chore: version packages");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-u", "origin", "main");
  const head = git(repository, "rev-parse", "HEAD");
  const artifacts = writeReleaseArtifacts({
    outputDirectory: join(root, "artifacts"),
    version: "2.0.0",
    date: "2026-08-05",
    changes: [
      {
        file: "calm-cats-dance.md",
        summary: "Publish the release engine.",
        body: "Publish the release engine.",
        impact: "minor",
        releases: [{ packageName: "@example/core", impact: "minor" }],
        authors: ["@ada"],
        pullRequests: [3367],
      },
    ],
  });
  const api = new FakeReleaseApi(options.failOnceFor);
  const client = createGithubClient({
    token: "fixture-token",
    baseUrl: "https://github.invalid/api/v3",
    fetchImpl: api.fetch,
    retryCount: 0,
    throttle: false,
  });
  const github = createGithubReleaseAdapter({
    client,
    owner: "example",
    repository: "widgets",
  });

  return {
    root,
    remote,
    repository,
    head,
    artifacts,
    api,
    publish: () => publishRelease({
      repoRoot: repository,
      version: "2.0.0",
      artifacts,
      github,
    }),
  };
}

/** github.com serves asset upload from `uploads.github.com`; the fixture mirrors
 * that split so the API host and the upload host are not the same origin. */
const UPLOAD_ORIGIN = "https://uploads.github.invalid";
const UPLOAD_URL = `${UPLOAD_ORIGIN}/repos/example/widgets/releases/1/assets{?name,label}`;

interface FakeRelease {
  readonly id: number;
  readonly upload_url: string;
  readonly tag_name: string;
  readonly target_commitish: string;
  readonly name: string;
  readonly body: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly FakeAsset[];
}

interface FakeAsset {
  readonly id: number;
  readonly name: string;
  readonly data: string;
}

class FakeReleaseApi {
  release: FakeRelease | null = null;
  assets: FakeAsset[] = [];
  createCalls = 0;
  successfulUploads: string[] = [];
  readonly fetch: GithubRequestFetch;
  private failed = false;

  constructor(private readonly failOnceFor?: string) {
    this.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/v3/, "");
      const onUploadHost = url.origin === UPLOAD_ORIGIN;

      // Asset upload is the one Release call GitHub does not serve from the API
      // host, so the fixture does not either. A uploader that builds the route
      // relative to the client's base URL gets the 404 the real host gives —
      // the whole failure this file exists to catch.
      if (method === "POST" && !onUploadHost && path.endsWith("/assets")) {
        return json({ message: "Not Found" }, 404);
      }

      if (method === "GET" && path === "/repos/example/widgets/releases/tags/v2.0.0") {
        if (this.release === null) return json({ message: "Not Found" }, 404);
        return json({ ...this.release, assets: this.assets });
      }
      if (method === "POST" && path === "/repos/example/widgets/releases") {
        this.createCalls += 1;
        const payload = JSON.parse(await bodyText(init?.body)) as Omit<
          FakeRelease,
          "id" | "assets" | "upload_url"
        >;
        this.release = { id: 1, ...payload, assets: [], upload_url: UPLOAD_URL };
        return json(this.release, 201);
      }
      if (method === "POST" && onUploadHost && path === "/repos/example/widgets/releases/1/assets") {
        const name = url.searchParams.get("name") ?? "";
        if (name === this.failOnceFor && !this.failed) {
          this.failed = true;
          return json({ message: "fixture upload interruption" }, 503);
        }
        const asset = { id: this.assets.length + 1, name, data: await bodyText(init?.body) };
        this.assets.push(asset);
        this.successfulUploads.push(name);
        return json(asset, 201);
      }
      return json({ message: `unexpected ${method} ${path}` }, 500);
    };
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function bodyText(
  body: ConstructorParameters<typeof Response>[0] | undefined,
): Promise<string> {
  if (body === undefined || body === null) return "";
  return await new Response(body).text();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
