import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_STRING,
  BRAIN_ROOT_ENV,
  findBrainRoot,
  interpolateEnv,
  parseBrainRootOverride,
  resolveBrainConfig,
  resolveConnectionString,
} from "../src/config.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-config-"));
  roots.push(root);
  return root;
}

function hasRedAncestor(path: string): boolean {
  let current = resolve(path);
  while (true) {
    if (existsSync(join(current, ".red"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function tempRootWithoutRedAncestor(): Promise<string> {
  const candidates = new Set(
    [
      process.env.RUNNER_TEMP,
      process.env.TMPDIR,
      tmpdir(),
      process.platform === "win32" ? undefined : "/var/tmp",
      process.platform === "win32" ? undefined : "/dev/shm",
    ].filter((candidate): candidate is string => Boolean(candidate)),
  );

  for (const parent of candidates) {
    if (!existsSync(parent) || hasRedAncestor(parent)) continue;
    const root = await mkdtemp(join(parent, "brain-config-"));
    roots.push(root);
    return root;
  }

  throw new Error("No temporary parent without a .red ancestor is available");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Brain config", () => {
  // ADR 0152: brain is the USER's, so a directory that carries no store of its
  // own resolves to the host root rather than minting a per-checkout brain.
  it("uses the host root when no directory on the path carries a brain", async () => {
    const root = await tempRootWithoutRedAncestor();
    const env = { HOME: root };
    await expect(findBrainRoot(root, { env })).resolves.toBe(join(root, ".red"));
  });

  it("keeps a checkout that already carries a brain store", async () => {
    const root = await tempRootWithoutRedAncestor();
    await mkdir(join(root, ".red", "brain"), { recursive: true });
    await expect(findBrainRoot(root, { env: { HOME: "/nonexistent-home" } })).resolves.toBe(root);
  });

  it("uses an ancestor umbrella brain instead of a child repo .red directory", async () => {
    const org = await tempRoot();
    const repo = join(org, "service");
    const start = join(repo, "src", "feature");
    await mkdir(join(org, ".red", "brain"), { recursive: true });
    await mkdir(join(repo, ".red"), { recursive: true });
    await mkdir(start, { recursive: true });

    await expect(findBrainRoot(start)).resolves.toBe(org);
  });

  it("resolves brain config inside the umbrella brain from a child repo", async () => {
    const org = await tempRoot();
    const repo = join(org, "service");
    const start = join(repo, "src");
    await mkdir(join(org, ".red", "brain"), { recursive: true });
    await mkdir(join(repo, ".red"), { recursive: true });
    await mkdir(start, { recursive: true });

    const resolved = await resolveBrainConfig(start);

    expect(resolved.rootDir).toBe(org);
    expect(resolved.configPath).toBe(join(org, ".red", "brain", "config.yaml"));
    await expect(readFile(join(repo, ".red", "brain", "config.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("uses an explicit brain-root marker as a brain root", async () => {
    const org = await tempRoot();
    const repo = join(org, "service");
    const start = join(repo, "src");
    await mkdir(join(org, ".red"), { recursive: true });
    await mkdir(join(repo, ".red"), { recursive: true });
    await mkdir(start, { recursive: true });
    await writeFile(join(org, ".red", "brain.root"), "");

    await expect(findBrainRoot(start)).resolves.toBe(org);
  });

  it("resolves sibling umbrella brains independently", async () => {
    const workspace = await tempRoot();
    const reddb = join(workspace, "reddb.io");
    const tetis = join(workspace, "tetis.io");
    const reddbRepo = join(reddb, "api");
    const tetisRepo = join(tetis, "api");
    await mkdir(join(reddb, ".red", "brain"), { recursive: true });
    await mkdir(join(tetis, ".red", "brain"), { recursive: true });
    await mkdir(join(reddbRepo, ".red"), { recursive: true });
    await mkdir(join(tetisRepo, ".red"), { recursive: true });

    await expect(findBrainRoot(reddbRepo)).resolves.toBe(reddb);
    await expect(findBrainRoot(tetisRepo)).resolves.toBe(tetis);
  });

  // A bare `.red` is not a brain (ADR 0152): the walk-up honours a checkout that
  // HOLDS a store, and anything else is the user's host brain.
  it("prefers the host root over a .red ancestor that carries no brain", async () => {
    const root = await tempRoot();
    const repo = join(root, "service");
    const start = join(repo, "src");
    await mkdir(join(repo, ".red"), { recursive: true });
    await mkdir(start, { recursive: true });

    await expect(findBrainRoot(start, { env: { HOME: root } })).resolves.toBe(join(root, ".red"));
  });

  it("lets an environment root override walk-up brain resolution", async () => {
    const workspace = await tempRoot();
    const umbrella = join(workspace, "umbrella");
    const override = join(workspace, "override");
    const repo = join(umbrella, "service");
    await mkdir(join(umbrella, ".red", "brain"), { recursive: true });
    await mkdir(join(override, ".red", "brain"), { recursive: true });
    await mkdir(join(repo, ".red"), { recursive: true });

    await expect(findBrainRoot(repo, { env: { [BRAIN_ROOT_ENV]: override } })).resolves.toBe(override);
  });

  it("lets a config root override walk-up brain resolution", async () => {
    const workspace = await tempRoot();
    const umbrella = join(workspace, "umbrella");
    const override = join(workspace, "override");
    const repo = join(umbrella, "service");
    await mkdir(join(umbrella, ".red", "brain"), { recursive: true });
    await mkdir(join(override, ".red", "brain"), { recursive: true });
    await mkdir(join(repo, ".red"), { recursive: true });
    await writeFile(
      join(repo, ".red", "config.yaml"),
      "plugins:\n  brain:\n    rootDir: ../../override\n",
    );

    await expect(findBrainRoot(repo)).resolves.toBe(override);
  });

  it("parses brain root overrides from unified config", () => {
    expect(parseBrainRootOverride("plugins:\n  brain:\n    rootDir: ../brain\n")).toBe("../brain");
  });

  it("resolves file connection strings relative to the workspace root", () => {
    expect(resolveConnectionString("/repo", DEFAULT_CONNECTION_STRING)).toBe(
      "file:///repo/.red/brain/brain.rdb",
    );
  });

  it("interpolates variables from a provided environment map", () => {
    expect(interpolateEnv("$RED_BRAIN_CONNECTION_STRING", {
      RED_BRAIN_CONNECTION_STRING: "file:///tmp/brain.rdb",
    })).toBe("file:///tmp/brain.rdb");
  });

  it("loads workspace .env beside .red", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "brain"), { recursive: true });
    await writeFile(join(root, ".red", "brain", "config.yaml"), "connection_string: $RED_BRAIN_CONNECTION_STRING\n");
    await writeFile(join(root, ".env"), "RED_BRAIN_CONNECTION_STRING=file://./.red/brain/from-env.rdb\n");
    const resolved = await resolveBrainConfig(root);
    expect(resolved.connectionString).toBe(`file://${join(root, ".red", "brain", "from-env.rdb")}`);
  });
});
