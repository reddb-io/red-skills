import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Brain config", () => {
  it("uses the initial directory when no .red ancestor exists", async () => {
    const root = await tempRoot();
    await expect(findBrainRoot(root)).resolves.toBe(root);
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

  it("falls back to the nearest .red ancestor when no brain root exists", async () => {
    const root = await tempRoot();
    const repo = join(root, "service");
    const start = join(repo, "src");
    await mkdir(join(repo, ".red"), { recursive: true });
    await mkdir(start, { recursive: true });

    await expect(findBrainRoot(start)).resolves.toBe(repo);
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
