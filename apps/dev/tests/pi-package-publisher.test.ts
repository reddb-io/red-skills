import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const publisher = join(ROOT, "scripts/publish-pi-packages.mjs");

describe("Pi package publisher (dry-run)", () => {
  it("prints the would-be pnpm publish invocation per staged package and exits 0", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-publish-"));

    await mkdir(join(root, "packaging/pi/dev"), { recursive: true });
    await mkdir(join(root, "packaging/pi/memory"), { recursive: true });

    await writeFile(
      join(root, "packaging/pi/dev/package.json"),
      `${JSON.stringify({
        name: "@reddb-io/red-skills-dev",
        version: "9.9.9",
      }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(root, "packaging/pi/memory/package.json"),
      `${JSON.stringify({
        name: "@reddb-io/red-skills-memory",
        version: "9.9.9",
      }, null, 2)}\n`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync("node", [
      publisher,
      "--root",
      root,
      "--dry-run",
    ]);

    expect(stdout).toContain("publish-pi: publishing @reddb-io/red-skills-dev@9.9.9");
    expect(stdout).toContain("publish-pi: publishing @reddb-io/red-skills-memory@9.9.9");
    // dry-run bypasses the npm-view probe so it never hits the network
    expect(stderr).toBe("");
    // shell pipes don't carry the summary line through in dry-run; verify
    // count by counting occurrences
    expect(stdout.match(/publish-pi: publishing/g)?.length).toBe(2);
  });

  it("restricts publishing to the --plugin subset when supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-publish-subset-"));

    await mkdir(join(root, "packaging/pi/dev"), { recursive: true });
    await mkdir(join(root, "packaging/pi/memory"), { recursive: true });
    await mkdir(join(root, "packaging/pi/brain"), { recursive: true });

    for (const name of ["dev", "memory", "brain"]) {
      await writeFile(
        join(root, `packaging/pi/${name}/package.json`),
        `${JSON.stringify({
          name: `@reddb-io/red-skills-${name}`,
          version: "9.9.9",
        }, null, 2)}\n`,
        "utf8",
      );
    }

    const { stdout } = await execFileAsync("node", [
      publisher,
      "--root",
      root,
      "--dry-run",
      "--plugin",
      "memory,brain",
    ]);

    expect(stdout).not.toContain("publishing @reddb-io/red-skills-dev@9.9.9");
    expect(stdout).toContain("publishing @reddb-io/red-skills-memory@9.9.9");
    expect(stdout).toContain("publishing @reddb-io/red-skills-brain@9.9.9");
  });
});