// Project identity used to be decided per bind by a live (often
// unauthenticated) GitHub read: past the 60/hour anonymous budget the same
// repository silently became `remote:<slug>` beside its `github:<id>` twin,
// splitting every store keyed by project id. A GitHub numeric id is immutable
// across renames, so one successful resolution is authoritative forever —
// these tests pin the durable cache and the credentialed, reported resolution
// path that make identity stop depending on the network.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createProjectIdentityStore,
  projectIdentityStorePath,
} from "../src/project-identity-store.js";
import { resolveAcpProjectIdentity } from "../src/project-workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratchStore() {
  const root = await mkdtemp(join(tmpdir(), "redskilled-identity-store-"));
  roots.push(root);
  const path = projectIdentityStorePath(join(root, "redskilled.registrations.toon"));
  return { root, path };
}

describe("the durable project identity store", () => {
  it("remembers a resolution and answers it back, case-insensitively, across instances", async () => {
    const { path } = await scratchStore();
    const store = createProjectIdentityStore(path, () => "2026-08-24T20:00:00.000Z");

    await store.remember({ slug: "RedDB-io/Red-Skills", githubId: "1240684599", fullName: "reddb-io/red-skills" });

    // A fresh instance reads the same file — the answer survives a daemon restart.
    const reborn = createProjectIdentityStore(path);
    await expect(reborn.read("reddb-io/red-skills")).resolves.toMatchObject({
      github_id: "1240684599",
      full_name: "reddb-io/red-skills",
      first_resolved_at: "2026-08-24T20:00:00.000Z",
    });
  });

  it("a re-confirmation updates the name and keeps the first resolution instant", async () => {
    const { path } = await scratchStore();
    let now = "2026-08-24T20:00:00.000Z";
    const store = createProjectIdentityStore(path, () => now);

    await store.remember({ slug: "a/b", githubId: "7", fullName: "a/b" });
    now = "2026-08-25T09:00:00.000Z";
    await store.remember({ slug: "a/b", githubId: "7", fullName: "a/b-renamed" });

    await expect(store.read("a/b")).resolves.toMatchObject({
      full_name: "a/b-renamed",
      first_resolved_at: "2026-08-24T20:00:00.000Z",
      last_confirmed_at: "2026-08-25T09:00:00.000Z",
    });
  });

  it("an absent or unreadable snapshot answers nothing rather than throwing", async () => {
    const store = createProjectIdentityStore("/nowhere/identities.toon");
    await expect(store.read("a/b")).resolves.toBeUndefined();
  });
});

describe("identity resolution rides the cache, the daemon credential, and the demotion report", () => {
  async function gitCheckout(remote: string): Promise<string> {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), "redskilled-identity-checkout-"));
    roots.push(root);
    await run("git", ["-C", root, "init", "--quiet"]);
    await run("git", ["-C", root, "remote", "add", "origin", remote]);
    return root;
  }

  it("resolves a cached github identity without any network call", async () => {
    const cwd = await gitCheckout("https://github.com/reddb-io/red-skills.git");
    const fetchImpl = vi.fn(async () => {
      throw new Error("the network must not be asked");
    });

    const identity = await resolveAcpProjectIdentity(cwd, {
      env: {},
      fetchImpl: fetchImpl as never,
      identityCache: {
        read: async () => ({ github_id: "1240684599", full_name: "reddb-io/red-skills" }),
        remember: async () => {},
      },
    });

    expect(identity.projectId).toBe("github:1240684599");
    expect(identity.projectLabel).toBe("reddb-io/red-skills");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("threads the daemon credential into the read and remembers the answer", async () => {
    const cwd = await gitCheckout("https://github.com/reddb-io/red-skills.git");
    const remembered: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      expect(init.headers.authorization).toBe("Bearer the-daemon-token");
      return {
        ok: true,
        json: async () => ({ id: 1240684599, full_name: "reddb-io/red-skills" }),
      } as never;
    });

    const identity = await resolveAcpProjectIdentity(cwd, {
      env: {},
      fetchImpl: fetchImpl as never,
      resolveToken: async () => "the-daemon-token",
      identityCache: {
        read: async () => undefined,
        remember: async (entry) => void remembered.push(entry),
      },
    });

    expect(identity.projectId).toBe("github:1240684599");
    expect(remembered).toEqual([{
      slug: "reddb-io/red-skills",
      githubId: "1240684599",
      fullName: "reddb-io/red-skills",
    }]);
  });

  it("reports the demotion when resolution fails instead of splitting silently", async () => {
    const cwd = await gitCheckout("https://github.com/reddb-io/red-skills.git");
    const demotions: string[] = [];

    const identity = await resolveAcpProjectIdentity(cwd, {
      env: {},
      fetchImpl: (async () => {
        throw new Error("rate limit exhausted");
      }) as never,
      onIdentityDemotion: (slug, reason) => demotions.push(`${slug}: ${reason}`),
    });

    expect(identity.projectId).toBe("remote:reddb-io/red-skills");
    expect(demotions).toEqual(["reddb-io/red-skills: rate limit exhausted"]);
  });
});
