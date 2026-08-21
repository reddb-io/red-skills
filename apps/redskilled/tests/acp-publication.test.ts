// The daemon publishes and lands on Worker request (#4019, ADR 0144 §3, ADR 0148).
//
// Three properties, one per acceptance criterion: a publish request puts the
// branch on the remote without the request ever carrying a credential; a land
// request opens the pull request and hands the merge to custody WITHOUT waiting
// for it; and a request from a Worker the daemon does not hold is refused
// before any of that happens.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindAcpWorkerLand,
  bindAcpWorkerPublish,
  landParams,
  publicationMethodDomain,
  publishParams,
  type RedskilledPublicationWorker,
} from "../src/acp-publication.js";
import {
  createRedskilledGithubGateway,
  createRedskilledGithubWriteUpstream,
  type CreateRedskilledGithubGatewayOptions,
  type RedskilledGithubGatewayRegistration,
} from "../src/github-gateway.js";
import type { AcpProjectWorkspace } from "../src/project-workspace.js";

const roots: string[] = [];
const gateways: { close?(): void }[] = [];

afterEach(async () => {
  // The custodian ticks on a timer and writes its record; closing before the
  // fixture goes keeps teardown from racing a write into a directory being removed.
  for (const gateway of gateways.splice(0)) gateway.close?.();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A stub remote, the daemon's Project workspace, and one Worker that committed.
 *
 * The Worker's Worktree is a CLONE of the Project workspace, exactly as
 * `materializeWorkerWorkspace` makes it — which is the whole reason publication
 * has to deliver the objects before it can push them.
 */
async function hostFixture(branch: string): Promise<{
  readonly root: string;
  readonly remote: string;
  readonly project: AcpProjectWorkspace;
  readonly worker: RedskilledPublicationWorker;
  readonly commit: string;
}> {
  const root = await fixtureRoot("redskilled-publication-");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "--initial-branch", "main", remote], { stdio: "ignore" });

  const seed = join(root, "seed");
  execFileSync("git", ["clone", "--quiet", "--", remote, seed], { stdio: "ignore" });
  git(seed, "config", "user.email", "daemon@example.invalid");
  git(seed, "config", "user.name", "redskilled");
  await writeFile(join(seed, "README.md"), "seed\n");
  git(seed, "add", "--", "README.md");
  git(seed, "commit", "-m", "seed");
  git(seed, "push", "--quiet", "origin", "main");

  const workspacePath = join(root, "workspace");
  execFileSync("git", ["clone", "--quiet", "--", remote, workspacePath], { stdio: "ignore" });

  const worktreePath = join(root, "worker", "worktree");
  execFileSync("git", ["clone", "--no-hardlinks", "--quiet", "--", workspacePath, worktreePath], {
    stdio: "ignore",
  });
  git(worktreePath, "config", "user.email", "worker@example.invalid");
  git(worktreePath, "config", "user.name", "Worker");
  git(worktreePath, "checkout", "--quiet", "-b", branch);
  await writeFile(join(worktreePath, "edited.txt"), "the inner agent only edits and commits\n");
  git(worktreePath, "add", "--", "edited.txt");
  git(worktreePath, "commit", "-m", "Refs #4019");
  const commit = git(worktreePath, "rev-parse", "HEAD");

  const project: AcpProjectWorkspace = {
    projectId: "R_publication",
    projectLabel: "acme/widgets",
    checkoutRoot: seed,
    workspacePath,
  };
  return {
    root,
    remote,
    project,
    commit,
    worker: { workerId: "0000000Worker", worktreePath, project },
  };
}

function registration(
  root: string,
  overrides: Partial<CreateRedskilledGithubGatewayOptions> = {},
): RedskilledGithubGatewayRegistration {
  const gateway = createRedskilledGithubGateway({
    upstream: async () => ({ value: {}, budget: null }),
    outboxPath: join(root, "github-outbox.toon"),
    writeUpstream: createRedskilledGithubWriteUpstream(),
    ...overrides,
  });
  gateways.push(gateway);
  return {
    gateway,
    credentialForProject: () => ({ profile: "engineering", credential: { secret: "fixture-secret" } }),
  };
}

describe("`_redskills/publish` — the daemon pushes the Worker's branch", () => {
  it("puts the commit on the remote from a Worktree the request never names", async () => {
    const host = await hostFixture("afk/4019-publication");
    const publish = bindAcpWorkerPublish({
      gateway: registration(host.root),
      held: () => host.worker,
    });

    const request = publishParams({
      idempotency_key: "worker-turn:s:1",
      branch: "afk/4019-publication",
      commit: host.commit,
    });
    const answer = await publish({ params: request });

    expect(git(host.remote, "rev-parse", "refs/heads/afk/4019-publication")).toBe(host.commit);
    expect(answer.worker_id).toBe("0000000Worker");
    expect(answer.commit).toBe(host.commit);
    // The credential is the daemon's. Neither half of the exchange carries it.
    expect(JSON.stringify(request)).not.toContain("fixture-secret");
    expect(JSON.stringify(answer)).not.toContain("fixture-secret");
  }, 30_000);

  it("refuses a request from a Worker this daemon does not hold", async () => {
    const host = await hostFixture("afk/4019-unheld");
    const publish = bindAcpWorkerPublish({
      gateway: registration(host.root),
      held: () => undefined,
    });

    await expect(publish({
      params: publishParams({
        idempotency_key: "worker-turn:s:1",
        branch: "afk/4019-unheld",
        commit: host.commit,
      }),
    })).rejects.toThrow(/no longer holds|does not hold/i);
    expect(() => git(host.remote, "rev-parse", "refs/heads/afk/4019-unheld")).toThrow();
  }, 30_000);

  it("refuses params that name a Project, a remote or another Worker", () => {
    expect(() => publishParams({
      idempotency_key: "k",
      branch: "afk/4019",
      commit: "0".repeat(40),
      worker_id: "somebody-else",
    })).toThrow();
    expect(() => publishParams({ idempotency_key: "k", branch: "afk/4019", commit: "not-a-sha" })).toThrow();
    expect(() => publishParams({ idempotency_key: "k", branch: "--upload-pack=evil", commit: "0".repeat(40) }))
      .toThrow();
  });
});

describe("`_redskills/land` — the daemon opens the PR and hands the merge on", () => {
  it("records custody and returns while the merge is still pending", async () => {
    const host = await hostFixture("afk/4019-landing");
    let armed = 0;
    const gateway = registration(host.root, {
      custodyPath: join(host.root, "github-custody.toon"),
      // Long enough that a landing which awaited the merge would time this out.
      custodyTickMs: 3_600_000,
      writeUpstream: async ({ write }) => write.kind === "pull-request" ? { number: 73 } : {},
      custodyUpstream: {
        observe: async () => ({ forge_state: "open-clean", native_intent: false }),
        arm: async () => {
          armed += 1;
          return { forge_state: "open-pending", native_intent: true };
        },
      },
    });
    const land = bindAcpWorkerLand({ gateway, held: () => host.worker });

    const answer = await land({
      params: landParams({
        idempotency_key: "worker-land:s:1",
        branch: "afk/4019-landing",
        commit: host.commit,
        base: "main",
        title: "The daemon publishes and lands",
        body: "Refs #4019",
        owner_ticket: 4019,
      }),
    });

    expect(answer.pull_request).toBe(73);
    expect(answer.worker_id).toBe("0000000Worker");
    // Custody is ACCEPTED, not finished: the Queue Custodian outlives the Worker.
    expect(answer.custody_state).toBe("active");
    expect(armed).toBe(0);
  }, 30_000);

  it("refuses a land request from a Worker this daemon does not hold", async () => {
    const host = await hostFixture("afk/4019-unheld-landing");
    const land = bindAcpWorkerLand({ gateway: registration(host.root), held: () => undefined });

    await expect(land({
      params: landParams({
        idempotency_key: "worker-land:s:1",
        branch: "afk/4019-unheld-landing",
        commit: host.commit,
        base: "main",
        title: "unheld",
        body: "Refs #4019",
        owner_ticket: 4019,
      }),
    })).rejects.toThrow(/no longer holds|does not hold/i);
  }, 30_000);
});

describe("the land decoder (#4130)", () => {
  const valid = {
    idempotency_key: "worker-land:s:1",
    branch: "afk/4130-decoder",
    commit: "a".repeat(40).replace(/a/g, "1a23b45c").slice(0, 40),
    base: "main",
    title: "t",
    body: "b",
    owner_ticket: 4130,
  };

  it("refuses a landing without the validated commit", () => {
    const { commit: _commit, ...withoutCommit } = valid;
    expect(() => landParams(withoutCommit)).toThrow(/cannot name|exactly/i);
  });

  it("refuses a commit that is not one full object name", () => {
    expect(() => landParams({ ...valid, commit: "main" })).toThrow(/object name/i);
    expect(() => landParams({ ...valid, commit: "abc123" })).toThrow(/object name/i);
  });

  it("pins the exact-keys contract", () => {
    expect(() => landParams({ ...valid, remote: "origin" })).toThrow();
    expect(landParams(valid).commit).toBe(valid.commit);
  });
});

describe("the publication domain", () => {
  it("declares both methods and advertises nothing on the public control plane", () => {
    const domain = publicationMethodDomain({ gateway: undefined, held: () => undefined });

    expect(domain.domain).toBe("publication");
    expect(domain.bindings.map((binding) => binding.method))
      .toEqual(["_redskills/publish", "_redskills/land"]);
    expect(domain.capability).toBeUndefined();
  });
});
