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
