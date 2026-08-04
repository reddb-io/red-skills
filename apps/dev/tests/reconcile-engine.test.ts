import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileEngineDelivery } from "../src/runtime/reconcile-engine.js";
import { parseCli } from "../src/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the one-command engine repair", () => {
  it("is reachable from the command printed by the engine floor", () => {
    expect(parseCli(["reconcile-engine"])).toEqual({ command: "reconcile-engine", args: [] });
  });

  it("warms the current bundle and re-points a standing registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "reconcile-engine-"));
    roots.push(root);
    const source = join(root, "dev.bundle.min.mjs");
    const cache = join(root, "cache");
    await writeFile(source, "// current engine\n");
    const calls: string[][] = [];

    const result = await reconcileEngineDelivery({
      root,
      version: "3.4.0",
      sourceBundle: source,
      cacheDir: cache,
      execPath: "/usr/bin/node",
      port: {
        registration: async () => ({
          argv: ["/usr/bin/node", join(cache, "dev-3.3.24.bundle.min.mjs"), "run", "--once"],
          env: {},
        }),
        renew: async () => undefined,
        restateLaunch: async (launch) => { calls.push([...launch.argv]); },
      },
    });

    expect(await readFile(result.bundle_path, "utf8")).toBe("// current engine\n");
    expect(calls).toEqual([[
      "/usr/bin/node",
      join(cache, "dev-3.4.0.bundle.min.mjs"),
      "run",
      "--once",
    ]]);
    expect(result.registration).toBe("repointed");
  });
});
