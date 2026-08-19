import { describe, expect, it } from "vitest";

import {
  REDSKILLS_ACP_METHODS,
  WORKTREE_REFUSAL_REASONS,
  worktreeAddParams,
} from "@reddb-io/protocol-acp";

import {
  bindAcpWorktreeAdd,
  bindAcpWorktreeList,
  interactiveWorktreeDirectory,
  parseWorktreePorcelain,
  worktreeMethodDomain,
  REDSKILLED_INTERACTIVE_WORKTREE_LANE,
  type AcpWorktreeDeps,
  type RedskilledRegisteredCheckout,
  type RedskilledWorkerWorktree,
} from "../src/acp-worktree.js";

const CHECKOUT = "/home/dev/red-skills";

/** A registered checkout with the git coordinates a registration carries. */
function registered(overrides: Partial<RedskilledRegisteredCheckout> = {}): RedskilledRegisteredCheckout {
  return {
    project_label: "reddb-io/red-skills",
    checkout_root: CHECKOUT,
    trunk: { remote: "origin", branch: "main" },
    ...overrides,
  };
}

/** A git that records its argv instead of touching a repository. */
function stubGit(answers: Readonly<Record<string, string>> = {}) {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  return {
    calls,
    run: async (cwd: string, args: readonly string[]): Promise<string> => {
      calls.push({ cwd, args });
      return answers[args[0] ?? ""] ?? "";
    },
  };
}

function deps(
  checkout: RedskilledRegisteredCheckout | undefined,
  git: AcpWorktreeDeps["git"],
  workers: readonly RedskilledWorkerWorktree[] = [],
): AcpWorktreeDeps {
  return {
    registeredCheckout: () => checkout,
    workerWorktrees: () => workers,
    ...(git === undefined ? {} : { git }),
  };
}

describe("_redskills/worktree_add", () => {
  it("creates the worktree in the manual lane, forked from the freshly fetched trunk", async () => {
    const git = stubGit();
    const add = bindAcpWorktreeAdd(deps(registered(), git.run));

    const answer = await add({ params: { slug: "4021-worktree-add" }, client: undefined });

    expect(answer).toEqual({
      version: 1,
      kind: "interactive",
      path: ".red/tmp/worktrees/manual/4021-worktree-add",
      branch: "afk/4021-worktree-add",
      base: "origin/main",
      lane: REDSKILLED_INTERACTIVE_WORKTREE_LANE,
      project_label: "reddb-io/red-skills",
    });
    // Fetch FIRST: the base is a remote ref by construction, and a remote ref
    // this checkout has never seen is the other way the bare form fails.
    expect(git.calls.map((call) => call.args)).toEqual([
      ["fetch", "origin", "main"],
      ["worktree", "add", ".red/tmp/worktrees/manual/4021-worktree-add", "-b", "afk/4021-worktree-add", "origin/main"],
    ]);
    expect(git.calls.every((call) => call.cwd === CHECKOUT)).toBe(true);
  });

  it("honours a caller's branch and base, and still forks off the REMOTE ref", async () => {
    const git = stubGit();
    const add = bindAcpWorktreeAdd(deps(registered({ trunk: { remote: "upstream", branch: "develop" } }), git.run));

    const answer = await add({
      params: { slug: "release-toolchain", branch: "chore/release-toolchain", base: "next" },
      client: undefined,
    });

    expect(answer.branch).toBe("chore/release-toolchain");
    expect(answer.base).toBe("upstream/next");
    expect(git.calls[0]!.args).toEqual(["fetch", "upstream", "next"]);
    expect(git.calls[1]!.args).toContain("upstream/next");
  });

  it("refuses an unregistered checkout by name, and touches no git", async () => {
    const git = stubGit();
    const add = bindAcpWorktreeAdd(deps(undefined, git.run));

    await expect(add({ params: { slug: "anything" }, client: undefined })).rejects.toMatchObject({
      data: { reason: WORKTREE_REFUSAL_REASONS.checkoutNotRegistered },
    });
    expect(git.calls).toEqual([]);
  });

  it("refuses a registration that states no trunk when the caller names no base", async () => {
    const git = stubGit();
    const add = bindAcpWorktreeAdd(deps(registered({ trunk: undefined }), git.run));

    await expect(add({ params: { slug: "anything" }, client: undefined })).rejects.toMatchObject({
      data: { reason: WORKTREE_REFUSAL_REASONS.trunkUnknown },
    });
    expect(git.calls).toEqual([]);
  });
});

describe("worktree_add params", () => {
  it("refuses a slug that would not survive as a directory name", () => {
    expect(() => worktreeAddParams({ slug: "../../etc" })).toThrow();
    expect(() => worktreeAddParams({ slug: "" })).toThrow();
    expect(() => worktreeAddParams({ slug: "a slug with spaces" })).toThrow();
  });

  it("refuses a branch git would read as an option rather than as a ref", () => {
    expect(() => worktreeAddParams({ slug: "ok", branch: "--upload-pack=touch" })).toThrow();
    expect(() => worktreeAddParams({ slug: "ok", base: "main..evil" })).toThrow();
    expect(() => worktreeAddParams({ slug: "ok", base: "refs/heads/main~1" })).toThrow();
  });

  it("refuses a caller that names a checkout, a lane or a Project", () => {
    expect(() => worktreeAddParams({ slug: "ok", lane: "landing" })).toThrow();
    expect(() => worktreeAddParams({ slug: "ok", checkout: "/somewhere/else" })).toThrow();
  });

  it("accepts a slug alone, lowercased and trimmed", () => {
    expect(worktreeAddParams({ slug: "  4021-Worktree_Add  " })).toEqual({ slug: "4021-worktree_add" });
  });
});

describe("_redskills/worktree_list", () => {
  it("is the ONE inventory: the checkout's worktrees and the daemon's Workers", async () => {
    const git = stubGit({
      worktree: [
        `worktree ${CHECKOUT}`,
        "HEAD 1111111111111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        `worktree ${CHECKOUT}/.red/tmp/worktrees/manual/release-toolchain`,
        "HEAD 2222222222222222222222222222222222222222",
        "branch refs/heads/afk/release-toolchain",
        "",
        `worktree ${CHECKOUT}/.muse/worktrees/red-skills-9f2`,
        "HEAD 3333333333333333333333333333333333333333",
        "detached",
        "",
      ].join("\n"),
    });
    const list = bindAcpWorktreeList(deps(registered(), git.run, [
      { worker_id: "host:W4021", path: "/tmp/redskilled/workers/hIWOV/4021/worktree" },
    ]));

    const answer = await list();

    expect(git.calls).toEqual([{ cwd: CHECKOUT, args: ["worktree", "list", "--porcelain"] }]);
    expect(answer).toEqual({
      version: 1,
      project_label: "reddb-io/red-skills",
      worktrees: [
        { kind: "checkout", path: CHECKOUT, branch: "main" },
        {
          kind: "interactive",
          path: `${CHECKOUT}/.red/tmp/worktrees/manual/release-toolchain`,
          branch: "afk/release-toolchain",
          lane: "manual",
        },
        { kind: "unregistered", path: `${CHECKOUT}/.muse/worktrees/red-skills-9f2`, branch: null },
        { kind: "worker", path: "/tmp/redskilled/workers/hIWOV/4021/worktree", branch: null, worker_id: "host:W4021" },
      ],
    });
  });

  it("shows a worktree created by worktree_add with its kind", async () => {
    const created = interactiveWorktreeDirectory("4021-worktree-add");
    const git = stubGit({ worktree: `worktree ${CHECKOUT}/${created}\nbranch refs/heads/afk/4021-worktree-add\n` });

    const answer = await bindAcpWorktreeList(deps(registered(), git.run))();

    expect(answer.worktrees).toEqual([
      {
        kind: "interactive",
        path: `${CHECKOUT}/${created}`,
        branch: "afk/4021-worktree-add",
        lane: REDSKILLED_INTERACTIVE_WORKTREE_LANE,
      },
    ]);
  });

  it("refuses an unregistered checkout by name", async () => {
    const git = stubGit();

    await expect(bindAcpWorktreeList(deps(undefined, git.run))()).rejects.toMatchObject({
      data: { reason: WORKTREE_REFUSAL_REASONS.checkoutNotRegistered },
    });
    expect(git.calls).toEqual([]);
  });
});

describe("the worktree porcelain reader", () => {
  it("reads git's own inventory, detached heads included", () => {
    expect(parseWorktreePorcelain("worktree /a\nHEAD abc\ndetached\n\nworktree /b\nbranch refs/heads/x\n")).toEqual([
      { path: "/a", branch: null },
      { path: "/b", branch: "x" },
    ]);
  });

  it("answers an empty inventory rather than inventing one", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
  });
});

describe("the worktree method domain", () => {
  it("binds both methods and advertises them with the lane they land in", () => {
    const domain = worktreeMethodDomain(deps(registered(), stubGit().run));

    expect(domain.domain).toBe("worktree");
    expect(domain.bindings.map((binding) => binding.method)).toEqual([
      REDSKILLS_ACP_METHODS.worktreeAdd,
      REDSKILLS_ACP_METHODS.worktreeList,
    ]);
    expect(domain.capability).toMatchObject({
      worktree: { lane: REDSKILLED_INTERACTIVE_WORKTREE_LANE },
    });
  });

  it("lets worktree_list name nothing at all", () => {
    const [, list] = worktreeMethodDomain(deps(registered(), stubGit().run)).bindings;

    expect(list!.params({})).toEqual({});
    expect(() => list!.params({ checkout: "/somewhere/else" })).toThrow();
  });
});
