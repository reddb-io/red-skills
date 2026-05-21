import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { configPath, readConfig } from "../src/config.js";
import { initMarkdownOnly, markdownOnlyConfig } from "../src/init.js";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-init-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("markdown-only init", () => {
  test("config has hooks off, mcp off, reddb not required", () => {
    const config = markdownOnlyConfig();
    expect(config.mode).toBe("markdown-only");
    expect(config.hooks).toEqual({
      sessionStart: false,
      postToolUse: false,
      stop: false,
      preCompact: false,
    });
    expect(config.mcp).toBe(false);
    expect(config.reddb).toBe(false);
  });

  test("writes config to .red/memory/config.json and creates notes dir", async () => {
    const root = await tempRoot();
    const result = await initMarkdownOnly(root);

    expect(result.configPath).toBe(configPath(root));
    const written = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(written.mode).toBe("markdown-only");
    expect(written.hooks.sessionStart).toBe(false);
    expect(written.mcp).toBe(false);

    const notesStat = await stat(result.notesDir);
    expect(notesStat.isDirectory()).toBe(true);
  });

  test("readConfig round-trips what init wrote", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const config = await readConfig(root);
    expect(config?.mode).toBe("markdown-only");
    expect(config?.hooks.stop).toBe(false);
  });

  test("readConfig returns null before init", async () => {
    const root = await tempRoot();
    expect(await readConfig(root)).toBeNull();
  });
});
