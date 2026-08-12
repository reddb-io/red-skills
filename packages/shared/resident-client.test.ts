import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureResidentServer, resolveResidentPaths } from "./resident-client.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "resident-client-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const previousDebug = originalRspDebug;
  if (previousDebug == null) delete process.env.RSP_DEBUG;
  else process.env.RSP_DEBUG = previousDebug;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const originalRspDebug = process.env.RSP_DEBUG;

describe("resident client startup diagnostics", () => {
  it("uses TOON filenames for every durable rsp snapshot", async () => {
    const paths = resolveResidentPaths(await tempRoot());

    expect(paths.summaryPath).toMatch(/rsp-status-summary\.toon$/);
    expect(paths.registryPath).toMatch(/rsp-resident\.pid\.toon$/);
    expect(paths.summaryPath).not.toMatch(/\.jsonl?$/);
    expect(paths.registryPath).not.toMatch(/\.jsonl?$/);
  });

  it("includes exit code and stderr tail when a debug resident child exits before ready", async () => {
    const root = await tempRoot();
    const paths = resolveResidentPaths(root);
    process.env.RSP_DEBUG = "1";

    await expect(ensureResidentServer(paths, {
      storeUri: `file://${join(root, ".red", "tmp", "red-skills.rdb")}`,
      ttlDays: 7,
      byteBudget: 1024,
      serverCommand: process.execPath,
      serverArgs: ["-e", "process.stderr.write('resident child boom\\n'); process.exit(42);"],
    })).rejects.toThrow(/resident rsp server exited before ready\nexit code: 42\nstderr tail:\nresident child boom/);
  });
});
