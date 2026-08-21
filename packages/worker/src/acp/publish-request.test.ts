import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedskilledPublishRequest } from "@reddb-io/protocol-acp";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkerPublisher,
  readWorktreePublication,
  WORKER_PUBLISH_METHOD,
} from "./publish-request.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function recordingParent() {
  const requests: { readonly method: string; readonly params: RedskilledPublishRequest }[] = [];
  return {
    requests,
    request: async (method: string, params: RedskilledPublishRequest) => {
      requests.push({ method, params });
      return { published: true };
    },
  };
}

describe("the Worker's post-turn publication request", () => {
  it("asks the parent exactly once, naming the branch and the commit", async () => {
    const parent = recordingParent();
    const publisher = createWorkerPublisher({
      cwd: "/worktree",
      idempotencyScope: "worker-turn:s",
      request: parent.request,
      readPublication: async () => ({ branch: "afk/4016-terminal-policy", commit: "c0ffee" }),
    });

    const outcome = await publisher.publishTurn();

    expect(outcome).toEqual({
      status: "requested",
      publication: { branch: "afk/4016-terminal-policy", commit: "c0ffee" },
      receipt: { published: true },
    });
    expect(parent.requests).toEqual([{
      method: WORKER_PUBLISH_METHOD,
      params: {
        idempotency_key: "worker-turn:s:c0ffee",
        branch: "afk/4016-terminal-policy",
        commit: "c0ffee",
      },
    }]);
  });

  // A Worker spans several prompt turns. Re-asking for the commit the parent
  // already holds is not a retry — it is one publication asked for twice.
  it("stays silent on a turn that committed nothing new, and speaks again when it did", async () => {
    const parent = recordingParent();
    let commit = "c0ffee";
    const publisher = createWorkerPublisher({
      cwd: "/worktree",
      idempotencyScope: "worker-turn:s",
      request: parent.request,
      readPublication: async () => ({ branch: "afk/4016", commit }),
    });

    await publisher.publishTurn();
    expect(await publisher.publishTurn()).toBeNull();
    commit = "decade";
    await publisher.publishTurn();

    expect(parent.requests.map(({ params }) => ({ branch: params.branch, commit: params.commit }))).toEqual([
      { branch: "afk/4016", commit: "c0ffee" },
      { branch: "afk/4016", commit: "decade" },
    ]);
  });

  it("returns a parent's refusal instead of costing the Worker its turn", async () => {
    const publisher = createWorkerPublisher({
      cwd: "/worktree",
      idempotencyScope: "worker-turn:s",
      request: async () => {
        throw new Error("no GitHub gateway is bound to this Project");
      },
      readPublication: async () => ({ branch: "afk/4016", commit: "c0ffee" }),
    });

    expect(await publisher.publishTurn()).toEqual({
      status: "refused",
      publication: { branch: "afk/4016", commit: "c0ffee" },
      detail: "no GitHub gateway is bound to this Project",
    });
  });

  it("asks for nothing when the Worktree holds no publishable commit", async () => {
    const parent = recordingParent();
    const publisher = createWorkerPublisher({
      cwd: "/worktree",
      idempotencyScope: "worker-turn:s",
      request: parent.request,
      readPublication: async () => null,
    });

    expect(await publisher.publishTurn()).toBeNull();
    expect(parent.requests).toEqual([]);
  });
});

describe("reading the Worktree's publication", () => {
  it("names the branch the inner agent committed on and the commit it left", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-publish-"));
    roots.push(root);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "--initial-branch", "afk/4016-terminal-policy");
    git("config", "user.email", "worker@example.invalid");
    git("config", "user.name", "Worker");
    await writeFile(join(root, "edited.txt"), "the inner agent only edits and commits\n");
    git("add", "--", "edited.txt");
    git("commit", "-m", "Refs #4016");

    const publication = await readWorktreePublication(root);

    expect(publication?.branch).toBe("afk/4016-terminal-policy");
    expect(publication?.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("publishes nothing from a directory that is not a Worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-publish-bare-"));
    roots.push(root);

    expect(await readWorktreePublication(root)).toBeNull();
  });
});

describe("the publication owns its branch", () => {
  it("publishes as the Worker-unique ref regardless of the local branch name", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const anchored: string[] = [];
    const publisher = createWorkerPublisher({
      cwd: "/tmp/wt",
      idempotencyScope: "worker-turn:s1",
      request: async (_method, params) => {
        requests.push(params as unknown as Record<string, unknown>);
        return { ok: true };
      },
      readPublication: async () => ({ branch: "main", commit: "a".repeat(40) }),
      updateRef: async (_cwd, ref, commit) => void anchored.push(`${ref}@${commit.slice(0, 4)}`),
      publishRef: "red/W1/4157",
    });

    const outcome = await publisher.publishTurn();

    // An agent that committed on `main` must not publish `refs/heads/main`
    // (rejected non-fast-forward at the canonical repository), and a reused
    // branch name must not collide with a merged branch's corpse (#4157).
    expect(requests[0]?.branch).toBe("red/W1/4157");
    // The daemon delivers by fetching refs/heads/<branch> FROM the Worktree,
    // so the publish-as name must exist there before the request goes out.
    expect(anchored).toEqual(["refs/heads/red/W1/4157@aaaa"]);
    expect(outcome?.status).toBe("requested");
    expect(outcome && "publication" in outcome ? outcome.publication.branch : null).toBe("red/W1/4157");
  });
});

describe("a turn that commits nothing publishes nothing", () => {
  it("skips the publish when HEAD still equals the baseline", async () => {
    const requests: unknown[] = [];
    const publisher = createWorkerPublisher({
      cwd: "/tmp/wt",
      idempotencyScope: "worker-turn:s1",
      request: async (_method, params) => void requests.push(params),
      readPublication: async () => ({ branch: "main", commit: "b".repeat(40) }),
      baselineCommit: "b".repeat(40),
      publishRef: "red/W1/9",
      updateRef: async () => {},
    });

    // The branch equalled main and GitHub answered "No commits between" — a
    // doomed land the Worker itself can refuse for free (#4157).
    expect(await publisher.publishTurn()).toBeNull();
    expect(requests).toEqual([]);
  });
});

