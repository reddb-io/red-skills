import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_STRING,
  findBrainRoot,
  interpolateEnv,
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
