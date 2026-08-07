import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGithubClient,
  type GithubRequestFetch,
} from "@reddb-io/github";
import {
  RELEASE_BOT_AUTHOR,
  RELEASE_BOT_EMAIL,
  runReleaseEngine,
  type ReleaseEngineGithub,
  type VersionPullRequest,
  type VersionPullRequestInput,
} from "../src/release-engine.js";
import type {
  CreateReleaseInput,
  PublishedRelease,
  UploadReleaseAssetInput,
} from "../src/github-release-adapter.js";
import { createGithubReleaseAdapter } from "../src/github-release-adapter.js";

const temporaryDirectories: string[] = [];
const FIXED_CLOCK = { today: () => ({ year: 2026, month: 8 }) };

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release engine", () => {
  it("graduates successive RCs from the Version-PR revision before consuming its queue once", async () => {
    const fixture = releaseFixture("version-pr", { prerelease: true });
    fixture.addChangeset("patient-otters-build.md", "minor", "Graduate the tested release.");

    await fixture.push();
    const versionPullRequestCommit = fixture.github.pullRequests[0]!.headCommit;
    const versionPullRequestTree = git(
      fixture.repository,
      "rev-parse", `${versionPullRequestCommit}^{tree}`,
    );

    await expect(fixture.releaseCandidate(1)).resolves.toMatchObject({
      kind: "published",
      version: "1.3.0-rc.1",
      tag: "v1.3.0-rc.1",
      commit: versionPullRequestCommit,
    });
    await expect(fixture.releaseCandidate(1)).resolves.toMatchObject({
      kind: "published",
      version: "1.3.0-rc.2",
      tag: "v1.3.0-rc.2",
      commit: versionPullRequestCommit,
    });

    expect(fixture.github.releases).toMatchObject([
      { tag: "v1.3.0-rc.1", prerelease: true },
      { tag: "v1.3.0-rc.2", prerelease: true },
    ]);
    expect(git(
      fixture.repository,
      "rev-parse", "refs/tags/v1.3.0-rc.2^{tree}",
    )).toBe(versionPullRequestTree);
    expect(fixture.versionOnRemoteBranch("main")).toBe("1.2.3");
    expect(fixture.filesOnRemoteBranch("main")).toContain(
      ".changeset/patient-otters-build.md",
    );

    const mergeCommit = fixture.mergeVersionPullRequest();
    await fixture.merge(1);
    await fixture.merge(1);

    expect(git(fixture.repository, "rev-parse", `${mergeCommit}^{tree}`))
      .toBe(versionPullRequestTree);
    expect(fixture.versionOnRemoteBranch("main")).toBe("1.3.0");
    expect(fixture.filesOnRemoteBranch("main")).not.toContain(
      ".changeset/patient-otters-build.md",
    );
    expect(fixture.github.releases.filter(({ tag }) => tag === "v1.3.0"))
      .toMatchObject([{ tag: "v1.3.0", prerelease: false }]);
  });

  it("maintains one Version PR as the queue grows, then publishes its merged revision", async () => {
    const fixture = releaseFixture("version-pr");
    fixture.addChangeset("calm-cats-dance.md", "minor", "Add the release engine.");

    await expect(fixture.push()).resolves.toMatchObject({
      kind: "version-pr",
      action: "created",
      number: 1,
      version: "1.3.0",
    });
    expect(fixture.github.pullRequests).toHaveLength(1);
    expect(fixture.github.pullRequests[0]?.title).toBe("chore(release): 1.3.0");
    expect(fixture.github.pullRequests[0]?.body).toContain("Add the release engine.");
    expect(fixture.versionOnRemoteBranch("red-release/version-pr")).toBe("1.3.0");

    fixture.addChangeset("bright-dogs-smile.md", "patch", "Correct the release notes.");
    await expect(fixture.push()).resolves.toMatchObject({
      kind: "version-pr",
      action: "updated",
      number: 1,
      version: "1.3.0",
    });
    expect(fixture.github.pullRequests).toHaveLength(1);
    expect(fixture.github.pullRequests[0]?.body).toContain("Correct the release notes.");

    const mergeCommit = fixture.mergeVersionPullRequest();
    await expect(fixture.merge(1)).resolves.toMatchObject({
      kind: "published",
      version: "1.3.0",
      tag: "v1.3.0",
      commit: mergeCommit,
    });
    expect(git(fixture.remote, "show-ref", "--hash", "refs/tags/v1.3.0")).toBe(mergeCommit);
    expect(fixture.github.release).toMatchObject({
      tag: "v1.3.0",
      targetCommitish: mergeCommit,
      body: expect.stringContaining("Correct the release notes."),
    });
  });

  it("consumes the queue and publishes directly on an auto-mode push", async () => {
    const fixture = releaseFixture("auto");
    fixture.addChangeset("quick-foxes-jump.md", "patch", "Correct the auto release.");

    await expect(fixture.push()).resolves.toMatchObject({
      kind: "published",
      version: "1.2.4",
      tag: "v1.2.4",
    });

    expect(fixture.github.pullRequests).toEqual([]);
    expect(fixture.versionOnRemoteBranch("main")).toBe("1.2.4");
    expect(fixture.filesOnRemoteBranch("main")).not.toContain(
      ".changeset/quick-foxes-jump.md",
    );
    expect(fixture.github.release).toMatchObject({
      tag: "v1.2.4",
      targetCommitish: git(fixture.repository, "rev-parse", "origin/main"),
      body: expect.stringContaining("Correct the auto release."),
    });
  });

  it("does not retrigger from the flow-authored bump commit", async () => {
    const fixture = releaseFixture("auto");
    fixture.addChangeset("quiet-owls-rest.md", "patch", "Pin the release anti-loop.");
    await fixture.push();
    const releasedHead = git(fixture.repository, "rev-parse", "origin/main");

    await expect(fixture.pushAs(RELEASE_BOT_AUTHOR)).resolves.toEqual({
      kind: "ignored",
      reason: "release-bump",
    });

    expect(git(fixture.repository, "rev-parse", "origin/main")).toBe(releasedHead);
    expect(fixture.github.pullRequests).toEqual([]);
    expect(fixture.github.release?.tag).toBe("v1.2.4");
  });

  it("authors the release commit as an account GitHub can resolve, and still breaks its own loop", async () => {
    const fixture = releaseFixture("version-pr");
    fixture.addChangeset("steady-larks-sing.md", "minor", "Attribute the release commit.");
    await fixture.push();

    const branch = "origin/red-release/version-pr";
    // GitHub resolves commit -> account by EMAIL. An unresolvable address makes
    // the release commit authorless, so a `first_time_contributors` approval
    // policy holds every Version PR's checks at `action_required` and the train
    // ends by asking a human to click Approve.
    expect(git(fixture.repository, "log", "-1", "--format=%ae", branch))
      .toBe(RELEASE_BOT_EMAIL);
    expect(RELEASE_BOT_EMAIL).toMatch(/@users\.noreply\.github\.com$/);
    // The NAME carries the other role: the generated workflow's `if:` reads it
    // to skip the run its own bump commit would trigger.
    expect(git(fixture.repository, "log", "-1", "--format=%an", branch))
      .toBe(RELEASE_BOT_AUTHOR);
  });

  it("routes Version-PR create, update, and merge reads through the house GitHub adapter", async () => {
    const api = new FakePullRequestApi();
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

    await expect(github.upsertVersionPullRequest({
      base: "main",
      head: "red-release/version-pr",
      title: "chore(release): 1.3.0",
      body: "first preview",
    })).resolves.toEqual({ number: 7, created: true });
    await expect(github.upsertVersionPullRequest({
      base: "main",
      head: "red-release/version-pr",
      title: "chore(release): 1.3.0",
      body: "grown preview",
    })).resolves.toEqual({ number: 7, created: false });

    api.merge("merged-commit");
    await expect(github.findVersionPullRequest(7)).resolves.toEqual({
      number: 7,
      body: "grown preview",
      headCommit: "version-head",
      merged: true,
      mergeCommit: "merged-commit",
    });
    expect(api.routes).toEqual([
      "GET /repos/example/widgets/pulls",
      "POST /repos/example/widgets/pulls",
      "GET /repos/example/widgets/pulls",
      "PATCH /repos/example/widgets/pulls/7",
      "GET /repos/example/widgets/pulls/7",
    ]);
  });
});

function releaseFixture(
  trigger: "version-pr" | "auto",
  options: { readonly prerelease?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "red-release-engine-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const repository = join(root, "repository");
  git(root, "init", "--bare", remote);
  git(root, "init", "--initial-branch=main", repository);
  git(repository, "config", "user.name", "Release Fixture");
  git(repository, "config", "user.email", "release-fixture@example.invalid");
  write(repository, "package.json", `{
  "name": "fixture",
  "version": "1.2.3"
}\n`);
  write(repository, ".red/config.yaml", `release:
  scheme: semver
  trigger: ${trigger}
  prerelease: ${options.prerelease ?? false}
  version_surfaces:
    - path: package.json
      format: npm
`);
  git(repository, "add", "package.json", ".red/config.yaml");
  git(repository, "commit", "-m", "chore: fixture baseline");
  git(repository, "remote", "add", "origin", remote);
  git(repository, "push", "-u", "origin", "main");
  const github = new FakeGithub(repository);

  const invoke = (event: Parameters<typeof runReleaseEngine>[0]["event"]) =>
    runReleaseEngine({ repoRoot: repository, event, github, clock: FIXED_CLOCK });

  return {
    remote,
    repository,
    github,
    addChangeset(file: string, impact: "minor" | "patch", summary: string): void {
      write(repository, `.changeset/${file}`, `---\n"fixture": ${impact}\n---\n${summary}\n`);
      git(repository, "add", `.changeset/${file}`);
      git(repository, "commit", "-m", `feat: ${summary}`);
      git(repository, "push", "origin", "main");
    },
    push: () => invoke({ kind: "push", commitAuthor: "fixture-maintainer" }),
    pushAs: (commitAuthor: string) => invoke({ kind: "push", commitAuthor }),
    releaseCandidate: (number: number) => invoke({ kind: "release-candidate", number }),
    merge: (number: number) => invoke({ kind: "version-pr-merged", number }),
    mergeVersionPullRequest(): string {
      git(repository, "fetch", "origin", "red-release/version-pr");
      git(repository, "merge", "--no-ff", "origin/red-release/version-pr", "-m", "merge: Version PR");
      git(repository, "push", "origin", "main");
      const commit = git(repository, "rev-parse", "HEAD");
      github.markMerged(1, commit);
      return commit;
    },
    versionOnRemoteBranch(branch: string): string {
      const source = git(repository, "show", `origin/${branch}:package.json`);
      return (JSON.parse(source) as { version: string }).version;
    },
    filesOnRemoteBranch(branch: string): string[] {
      return git(repository, "ls-tree", "-r", "--name-only", `origin/${branch}`).split("\n");
    },
  };
}

type MutableVersionPullRequest = {
  -readonly [Key in keyof VersionPullRequest]: VersionPullRequest[Key];
} & { title: string };

class FakeGithub implements ReleaseEngineGithub {
  readonly pullRequests: MutableVersionPullRequest[] = [];
  readonly releases: PublishedRelease[] = [];
  private readonly assets = new Map<number, Array<{ id: number; name: string }>>();

  constructor(private readonly repository: string) {}

  get release(): PublishedRelease | null {
    return this.releases.at(-1) ?? null;
  }

  async upsertVersionPullRequest(input: VersionPullRequestInput) {
    const existing = this.pullRequests.find((pullRequest) => !pullRequest.merged);
    if (existing !== undefined) {
      existing.title = input.title;
      existing.body = input.body;
      existing.headCommit = git(this.repository, "rev-parse", `origin/${input.head}`);
      return { number: existing.number, created: false };
    }
    this.pullRequests.push({
      number: 1,
      title: input.title,
      body: input.body,
      headCommit: git(this.repository, "rev-parse", `origin/${input.head}`),
      merged: false,
      mergeCommit: null,
    });
    return { number: 1, created: true };
  }

  async findVersionPullRequest(number: number): Promise<VersionPullRequest | null> {
    return this.pullRequests.find((pullRequest) => pullRequest.number === number) ?? null;
  }

  markMerged(number: number, mergeCommit: string): void {
    const pullRequest = this.pullRequests.find((candidate) => candidate.number === number);
    if (pullRequest === undefined) throw new Error(`missing fixture pull request ${number}`);
    pullRequest.merged = true;
    pullRequest.mergeCommit = mergeCommit;
  }

  async findByTag(tag: string): Promise<PublishedRelease | null> {
    const release = this.releases.find((candidate) => candidate.tag === tag);
    return release === undefined
      ? null
      : { ...release, assets: this.assets.get(release.id) ?? [] };
  }

  async create(input: CreateReleaseInput): Promise<PublishedRelease> {
    const id = this.releases.length + 1;
    const release = {
      id,
      ...input,
      assets: [],
      uploadUrl: `https://uploads.github.invalid/releases/${id}/assets{?name,label}`,
    };
    this.releases.push(release);
    this.assets.set(release.id, []);
    return release;
  }

  async uploadAsset(input: UploadReleaseAssetInput): Promise<void> {
    const assets = this.assets.get(input.releaseId);
    if (assets === undefined) throw new Error(`missing fixture release ${input.releaseId}`);
    assets.push({ id: assets.length + 1, name: input.name });
  }
}

class FakePullRequestApi {
  readonly routes: string[] = [];
  readonly fetch: GithubRequestFetch;
  private pullRequest: Record<string, unknown> | null = null;

  constructor() {
    this.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/v3/, "");
      this.routes.push(`${method} ${path}`);
      if (method === "GET" && path === "/repos/example/widgets/pulls") {
        return response(
          this.pullRequest === null ? [] : [{ number: this.pullRequest.number }],
        );
      }
      if (method === "POST" && path === "/repos/example/widgets/pulls") {
        const payload = JSON.parse(await requestBody(init?.body)) as Record<string, unknown>;
        this.pullRequest = this.payload(payload);
        return response(this.pullRequest, 201);
      }
      if (method === "PATCH" && path === "/repos/example/widgets/pulls/7") {
        const payload = JSON.parse(await requestBody(init?.body)) as Record<string, unknown>;
        this.pullRequest = this.payload({ ...this.pullRequest, ...payload });
        return response(this.pullRequest);
      }
      if (method === "GET" && path === "/repos/example/widgets/pulls/7") {
        return response(this.pullRequest);
      }
      return response({ message: `unexpected ${method} ${path}` }, 500);
    };
  }

  merge(commit: string): void {
    this.pullRequest = { ...this.pullRequest, merged: true, merge_commit_sha: commit };
  }

  private payload(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      number: 7,
      body: fields.body,
      head: { sha: "version-head" },
      merged: false,
      merge_commit_sha: null,
    };
  }
}

function write(root: string, path: string, source: string): void {
  const absolutePath = join(root, path);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, source);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function requestBody(
  body: ConstructorParameters<typeof Response>[0] | undefined,
): Promise<string> {
  if (body === undefined || body === null) return "";
  return new Response(body).text();
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
