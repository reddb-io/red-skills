import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { RspElisionStore } from "../src/elision-store.js";

const roots: string[] = [];
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const packageRoot = join(import.meta.dirname, "..");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runRsp(root: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    encoding: "buffer",
  });
}

function runRspFromCwd(cwd: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "buffer",
  });
}

function runGit(args: string[]) {
  return spawnSync("git", args, { encoding: "buffer" });
}

async function initGitRepo(): Promise<string> {
  const root = await tempRoot();
  const init = runGit(["-C", root, "init"]);
  expect(init.status).toBe(0);
  return root;
}

describe("rsp cli", () => {
  it("fails closed instead of creating the default Repo store when setup has not provisioned it", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });

    const res = runRspFromCwd(root, [], {});

    expect(res.status).toBe(1);
    expect(res.stdout).toEqual(Buffer.from("error: rsp repo store is not provisioned - run /red-setup\n"));
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes through a successful wrapper when the repo store has not been provisioned", async () => {
    const root = await initGitRepo();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, "untracked.txt"), "raw stdout\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "-C", root, "status", "--short"], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(direct.stderr);
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes through a failing wrapper with the underlying exit code and raw stderr when the store is absent", async () => {
    const root = await initGitRepo();
    await mkdir(join(root, ".red"), { recursive: true });
    const args = ["-C", root, "definitely-not-a-git-subcommand"];
    const direct = runGit(args);

    const res = runRspFromCwd(root, ["git", ...args], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(direct.stderr);
  });

  it("passes through wrappers when the configured store is unreadable", async () => {
    const root = await initGitRepo();
    const storeRoot = await tempRoot();
    const storePath = join(storeRoot, "red.rdb");
    await writeFile(storePath, "not a reddb store", "utf8");
    await writeFile(join(root, "raw.txt"), "raw\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "-C", root, "status", "--short"], { RSP_STORE_URI: `file://${storePath}` });

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(direct.stderr);
  });

  it("passes through wrappers when rsp hits an internal wrapper error after opening the store", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({ uri: storeUri });
    await store.close();
    const direct = runGit(["--version"]);

    const res = runRsp(root, ["git", "--version"], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(direct.stderr);
  });

  it("prints store stats instead of help when called without arguments", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({
      uri: storeUri,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      await store.mint(Buffer.from("abc"), {
        command: "cmd",
        loss: { level: "terse", bytes_elided: 3 },
      });
    } finally {
      await store.close();
    }

    const res = runRsp(root, [], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(Buffer.from("records: 1\nbytes: 3\noldest: 2026-07-10T12:00:00.000Z\nbudget: 67108864\n"));
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("rsp show prints original bytes verbatim on hit", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, "red.rdb")}`;
    const original = Buffer.from([0x1b, 0x5b, 0x33, 0x32, 0x6d, 0x00, 0x62, 0xff]);
    const store = await RspElisionStore.open({ uri: storeUri });
    let handle = "";
    try {
      handle = await store.mint(original, {
        command: "printf bytes",
        loss: { level: "terse", bytes_elided: original.length },
      });
    } finally {
      await store.close();
    }

    const res = runRsp(root, ["show", handle], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(original);
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("rsp show prints structured expiry with the original command and exits 1", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, "red.rdb")}`;
    let now = new Date("2026-07-10T12:00:00.000Z");
    const store = await RspElisionStore.open({ uri: storeUri, ttlDays: 1, now: () => now });
    let handle = "";
    try {
      handle = await store.mint(Buffer.from("old"), {
        command: "rerun me",
        loss: { level: "terse", bytes_elided: 3 },
      });
      now = new Date("2026-07-12T12:00:00.000Z");
      await store.mint(Buffer.from("new"), {
        command: "new",
        loss: { level: "terse", bytes_elided: 3 },
      });
    } finally {
      await store.close();
    }

    const res = runRsp(root, ["show", handle], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(1);
    expect(res.stdout).toEqual(Buffer.from("expired 2026-07-11T12:00:00.000Z — re-run: rerun me\n"));
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });
});
