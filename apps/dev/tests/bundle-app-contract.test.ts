import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const bundleApp = join(ROOT, "scripts/bundle-app.mjs");
const anchorPkgPath = join(ROOT, "apps/dev/package.json");

async function readAnchorVersion(): Promise<string> {
  const raw = await readFile(anchorPkgPath, "utf8");
  return JSON.parse(raw).version as string;
}

describe("bundle-app contract", () => {
  it("fails when required args are missing", async () => {
    await expect(execFileAsync("node", [bundleApp])).rejects.toThrow(
      /--entry, --outfile and --asset are required/,
    );
    await expect(execFileAsync("node", [bundleApp, "--entry", "a"])).rejects.toThrow(
      /--entry, --outfile and --asset are required/,
    );
  });

  it("rejects unknown args", async () => {
    await expect(execFileAsync("node", [bundleApp, "--unknown"])).rejects.toThrow(
      /unknown arg/,
    );
  });

  it("bundles a minimal entry and injects version/banner defines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "red-skills-bundle-app-"));
    try {
      const entry = join(dir, "entry.ts");
      const out = join(dir, "out.mjs");
      await writeFile(entry, 'export const hello = __RED_BUILD_VERSION__;\nexport const asset = __RED_BUNDLE_ASSET__;\nexport const sha = __RED_BUILD_GIT_SHA__;\n');

      const anchorVersion = await readAnchorVersion();

      // Ensure anchor version is used when RED_BUILD_VERSION is absent
      const env = {
        ...process.env,
        RED_BUILD_VERSION: undefined,
        RED_BUILD_GIT_SHA: "test-sha-123",
        RED_BUILD_TIME: "2026-01-01T00:00:00.000Z",
      };
      // Remove RED_BUILD_VERSION from env copy
      delete (env as Record<string, string | undefined>).RED_BUILD_VERSION;

      await execFileAsync("node", [bundleApp, "--entry", entry, "--outfile", out, "--asset", "test-bundle"], {
        env: env as NodeJS.ProcessEnv,
      });

      const content = await readFile(out, "utf8");
      // Banner with createRequire must be present (esbuild --banner:js)
      expect(content).toContain("createRequire");
      // Version define: should contain anchor version (or 0.0.0-dev fallback) — not cwd package.json
      expect(content).toContain(anchorVersion);
      // Asset define
      expect(content).toContain("test-bundle");
      // Git SHA define
      expect(content).toContain("test-sha-123");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("RED_BUILD_VERSION env wins over anchor version (regression #3469/#3468)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "red-skills-bundle-app-env-"));
    try {
      const entry = join(dir, "entry.ts");
      const out = join(dir, "out.mjs");
      await writeFile(entry, 'export const x = __RED_BUILD_VERSION__;\nexport const y = __RED_BUILD_GIT_SHA__;\n');
      const fakeVersion = "9.9.9-env-wins";

      await execFileAsync("node", [bundleApp, "--entry", entry, "--outfile", out, "--asset", "env-test"], {
        env: {
          ...process.env,
          RED_BUILD_VERSION: fakeVersion,
          RED_BUILD_GIT_SHA: "env-sha",
        },
      });

      const content = await readFile(out, "utf8");
      expect(content).toContain(fakeVersion);
      expect(content).toContain("env-sha");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("strips leading v from RED_BUILD_VERSION (regression: tag vX.Y.Z)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "red-skills-bundle-app-v-"));
    try {
      const entry = join(dir, "entry.ts");
      const out = join(dir, "out.mjs");
      await writeFile(entry, 'export const y = __RED_BUILD_VERSION__;\n');

      await execFileAsync("node", [bundleApp, "--entry", entry, "--outfile", out, "--asset", "v-test"], {
        env: {
          ...process.env,
          RED_BUILD_VERSION: "v3.10.99",
        },
      });

      const content = await readFile(out, "utf8");
      // Should contain 3.10.99 without leading v
      expect(content).toContain("3.10.99");
      // The literal v3.10.99 string should not appear as version (but may appear in other contexts)
      // So we check the define is stripped: the bundle should not contain '"v3.10.99"' as version string
      // Instead it should have '"3.10.99"'
      expect(content).not.toContain('"v3.10.99"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("anchor version is single source — not cwd package.json (regression rsp@2.23 vs product@2.88)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "red-skills-bundle-anchor-"));
    try {
      const entry = join(dir, "entry.ts");
      const out = join(dir, "out.mjs");
      await writeFile(entry, 'export const z = __RED_BUILD_VERSION__;\n');
      const anchorVersion = await readAnchorVersion();

      // Anchor must be apps/dev/package.json regardless of cwd. We verify the
      // static contract already checks PRODUCT_VERSION_ANCHOR, and here we
      // verify runtime: without RED_BUILD_VERSION the bundle contains the
      // anchor version, not a fallback.
      await execFileAsync("node", [bundleApp, "--entry", entry, "--outfile", out, "--asset", "anchor-test"], {
        env: {
          ...process.env,
          RED_BUILD_VERSION: undefined,
        },
      });

      const content = await readFile(out, "utf8");
      expect(content).toContain(anchorVersion);
      // The bundle should not fall back to 0.0.0-dev when anchor exists
      expect(content).not.toContain("0.0.0-dev");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
