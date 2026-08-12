import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { renderShellInit } from "../src/shell-init.js";

const roots: string[] = [];
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const hasFish = spawnSync("fish", ["--version"], { encoding: "utf8" }).status === 0;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-shell-init-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp shell-init snippets", () => {
  it("renders fish abbreviations and rspx helper", () => {
    const snippet = renderShellInit("fish");

    expect(snippet).toContain("abbr --add --position command -- git 'rsp git'");
    expect(snippet).toContain("abbr --add --position command -- gh 'rsp gh'");
    expect(snippet).toContain("function rspx");
    expect(snippet).toContain("rsp exec -- $argv");
  });

  it("prints a shell snippet from the CLI without requiring an enabled repo", async () => {
    const root = await tempRoot();

    const res = spawnSync(process.execPath, ["--import", tsxLoader, cli, "shell-init", "fish"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("abbr --add --position command -- git 'rsp git'");
    expect(res.stdout).toContain("function rspx");
  });

  it("renders bash/zsh functions that intercept known wrapper families only", () => {
    const bash = renderShellInit("bash");
    const zsh = renderShellInit("zsh");

    for (const snippet of [bash, zsh]) {
      expect(snippet).toContain("git() {");
      expect(snippet).toContain("status|log|diff|commit|push|blame|show) command rsp git \"$@\" ;;");
      expect(snippet).toContain("branch) if [ \"$2\" = '-av' ]; then command rsp git \"$@\"; else command git \"$@\"; fi ;;");
      expect(snippet).toContain("pr) if [ \"$2\" = 'list' ] || [ \"$2\" = 'view' ]; then command rsp gh \"$@\"; else command gh \"$@\"; fi ;;");
      expect(snippet).toContain("rspx() {");
      expect(snippet).toContain("command rsp exec -- \"$@\"");
    }
  });

  it.skipIf(!hasFish)("emits fish syntax accepted by fish -n", async () => {
    const root = await tempRoot();
    const path = join(root, "rsp-init.fish");
    await writeFile(path, renderShellInit("fish"), "utf8");

    const res = spawnSync("fish", ["-n", path], { encoding: "utf8" });

    expect(res.status, res.stderr).toBe(0);
  });

  it.skipIf(!hasFish)("fish snippet installs command-word abbreviations and rspx when sourced", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    await writeFile(join(root, "rsp-init.fish"), renderShellInit("fish"), "utf8");
    await mkdir(bin);
    await writeFile(join(bin, "rsp"), "#!/bin/sh\nprintf 'rsp %s\\n' \"$*\"\n", { mode: 0o755 });
    await writeFile(join(root, "script.fish"), [
      `set -gx PATH '${bin}' $PATH`,
      `source '${join(root, "rsp-init.fish")}'`,
      "abbr --show git",
      "rspx 'git log | tail'",
      "",
    ].join("\n"), "utf8");

    const res = spawnSync("fish", [join(root, "script.fish")], { encoding: "utf8" });

    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("abbr -a -- git 'rsp git'");
    expect(res.stdout).toContain("rsp exec -- git log | tail");
  });

  it("bash snippet routes git status and rspx through rsp while preserving other git commands", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "rsp"), "#!/bin/sh\nprintf 'rsp %s\\n' \"$*\"\n", { mode: 0o755 });
    await writeFile(join(bin, "git"), "#!/bin/sh\nprintf 'git %s\\n' \"$*\"\n", { mode: 0o755 });
    await writeFile(join(root, "rsp-init.sh"), renderShellInit("bash"), "utf8");

    const res = spawnSync("bash", ["-c", [
      `PATH='${bin}':$PATH`,
      `source '${join(root, "rsp-init.sh")}'`,
      "git status",
      "git checkout topic",
      "rspx 'git log | tail'",
    ].join("; ")], { encoding: "utf8" });

    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("rsp git status");
    expect(res.stdout).toContain("git checkout topic");
    expect(res.stdout).toContain("rsp exec -- git log | tail");
  });
});
