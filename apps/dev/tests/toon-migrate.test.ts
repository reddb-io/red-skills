import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCli } from "../src/cli.js";
import { toonMigrateCommand } from "../src/commands/toon-migrate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "dev-toon-migrate-"));
  roots.push(root);
  return root;
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

describe("toon-migrate dev command", () => {
  test("routes as a dedicated dev CLI verb", () => {
    expect(parseCli(["toon-migrate", "--plugin", "memory", "--root", "/repo"])).toEqual({
      command: "toon-migrate",
      args: ["--plugin", "memory", "--root", "/repo"],
    });
  });

  test("converts a plugin-scoped registered surface", async () => {
    const root = await scratch();
    await write(root, ".red/memory/config.json", JSON.stringify({ mode: "graph" }));
    let stdout = "";
    let stderr = "";

    const code = await toonMigrateCommand(["--plugin", "memory", "--root", root, "--json"], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ status: "converted", converted: ["memory.config"] });
    expect(await readFile(join(root, ".red/memory/config.toon"), "utf8")).toContain("mode: graph");
  });

  test("refuses when the repo is not quiesced", async () => {
    const root = await scratch();
    await write(root, ".red/memory/config.json", JSON.stringify({ mode: "graph" }));
    await write(root, ".red/tmp/afk-supervisor.pid", `${process.pid}\n`);
    let stderr = "";

    const code = await toonMigrateCommand(["--plugin", "memory", "--root", root], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });

    expect(code).toBe(1);
    expect(stderr).toContain("refused");
    expect(stderr).toContain("active fleet supervisor");
  });
});
