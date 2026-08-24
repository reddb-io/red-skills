import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const appRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(appRoot, "..", "..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the published redskilled-link entry", () => {
  it("routes the CLI when invoked through an installed-current symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-entry-"));
    roots.push(root);
    const real = join(root, "sets", "4.2.7", "dist", "redskilled-link.bundle.min.mjs");
    await mkdir(dirname(real), { recursive: true });
    execFileSync(process.execPath, [
      join(repoRoot, "scripts", "bundle-app.mjs"),
      "--entry", join(appRoot, "src", "cli.ts"),
      "--outfile", real,
      "--asset", "redskilled-link.bundle.min.mjs",
      "--minify",
    ], { cwd: appRoot, stdio: "pipe" });
    const current = join(root, "current");
    await symlink(join(root, "sets", "4.2.7"), current, "dir");

    const invoked = spawnSync(process.execPath, [
      join(current, "dist", "redskilled-link.bundle.min.mjs"),
      "onboard", "--transport", "wireguard",
    ], { encoding: "utf8" });

    expect(invoked.status).toBe(2);
    expect(invoked.stdout).toContain("WireGuard transport is not available in this build");
  }, 30_000);
});
