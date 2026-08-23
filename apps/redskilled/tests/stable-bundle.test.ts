// The ExecStart target nothing on the host prunes (#3554 closure).
//
// The absolute-command fix left the unit's durability to whoever owns the
// directory the path points into: the npx cache is GC'd and a mise toolchain
// vanishes on prune, so an absolute path into either is a dead unit wearing a
// longer name. These checks pin the closure — a copy in the daemon's own home —
// and, just as deliberately, every case where stabilization must REFUSE:
// a copy filed under a version it is not would serve wrong code by name, and a
// copied shim is a file that runs nothing.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  redskilledStableBundleDir,
  redskilledStableBundleName,
  redskilledStatuslineBundleName,
  STATUSLINE_BUNDLE_ASSET,
  stabilizeRedskilledEntry,
} from "../src/stable-bundle.js";
import { requireRedskilledReplacementEntry } from "../src/self-replace.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(): Promise<{ homeDir: string; sourceDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-stable-"));
  roots.push(root);
  const homeDir = join(root, "home");
  await mkdir(join(homeDir, ".red", "redskilled"), { recursive: true });
  const sourceDir = join(root, "cache");
  await mkdir(sourceDir, { recursive: true });
  return { homeDir, sourceDir };
}

describe("stabilizing an entry into the daemon home", () => {
  it("copies a versioned bundle once and points the entry at the copy", async () => {
    const { homeDir, sourceDir } = await scratch();
    const source = join(sourceDir, "redskilled-4.0.0.bundle.min.mjs");
    await writeFile(source, "the published bytes");
    const entry = { command: "/usr/bin/node", args: [source], entry: source };

    const stable = stabilizeRedskilledEntry(entry, { homeDir });

    const target = join(redskilledStableBundleDir(homeDir), redskilledStableBundleName("4.0.0"));
    expect(stable.entry).toBe(target);
    expect(stable.args).toEqual([target]);
    expect(stable.command).toBe("/usr/bin/node");
    expect(readFileSync(target, "utf8")).toBe("the published bytes");

    // Idempotent: a second pass finds the copy and copies nothing.
    const again = stabilizeRedskilledEntry(entry, { homeDir });
    expect(again.entry).toBe(target);
  });

  it("stabilizes the statusline sibling beside the daemon bundle, under its own name", async () => {
    const { homeDir, sourceDir } = await scratch();
    const source = join(sourceDir, "redskilled-4.0.0.bundle.min.mjs");
    await writeFile(source, "the daemon bytes");
    await writeFile(join(sourceDir, STATUSLINE_BUNDLE_ASSET), "the lean renderer bytes");

    stabilizeRedskilledEntry({ command: "/usr/bin/node", args: [source], entry: source }, { homeDir });

    const sibling = join(
      redskilledStableBundleDir(homeDir),
      redskilledStatuslineBundleName("4.0.0"),
    );
    expect(readFileSync(sibling, "utf8")).toBe("the lean renderer bytes");
    // The sibling's name stays OUT of the daemon glob: `redskilled-*` sorted by
    // version must never resolve the lean renderer as the daemon bundle.
    expect(redskilledStatuslineBundleName("4.0.0").startsWith("redskilled-")).toBe(false);
  });

  it("stabilizes the daemon alone when the package carries no statusline sibling", async () => {
    const { homeDir, sourceDir } = await scratch();
    const source = join(sourceDir, "redskilled-4.0.0.bundle.min.mjs");
    await writeFile(source, "the daemon bytes");

    const stable = stabilizeRedskilledEntry(
      { command: "/usr/bin/node", args: [source], entry: source },
      { homeDir },
    );

    expect(stable.entry).toBe(
      join(redskilledStableBundleDir(homeDir), redskilledStableBundleName("4.0.0")),
    );
    expect(
      existsSync(join(redskilledStableBundleDir(homeDir), redskilledStatuslineBundleName("4.0.0"))),
    ).toBe(false);
  });

  it("returns an already-stable entry unchanged", async () => {
    const { homeDir } = await scratch();
    const stableDir = redskilledStableBundleDir(homeDir);
    await mkdir(stableDir, { recursive: true });
    const target = join(stableDir, redskilledStableBundleName("4.0.0"));
    await writeFile(target, "already home");
    const entry = { command: "/usr/bin/node", args: [target], entry: target };

    expect(stabilizeRedskilledEntry(entry, { homeDir })).toEqual(entry);
  });

  it("refuses without a certain version, and refuses a local build", async () => {
    const { homeDir, sourceDir } = await scratch();
    const unversioned = join(sourceDir, "redskilled.bundle.min.mjs");
    await writeFile(unversioned, "whose version?");
    const entry = { command: "/usr/bin/node", args: [unversioned], entry: unversioned };

    // No version stated and none in the name: unchanged, nothing copied.
    expect(stabilizeRedskilledEntry(entry, { homeDir })).toEqual(entry);
    // A stated version fixes that.
    const stable = stabilizeRedskilledEntry(entry, { homeDir, version: "4.1.0" });
    expect(stable.entry).toBe(join(redskilledStableBundleDir(homeDir), redskilledStableBundleName("4.1.0")));
    // A local build is one name for many different bytes: never filed.
    expect(stabilizeRedskilledEntry(entry, { homeDir, version: "0.0.0-dev" })).toEqual(entry);
  });

  it("refuses a shim and an npx dispatch — only the bundle is copyable", async () => {
    const { homeDir, sourceDir } = await scratch();
    const shim = join(sourceDir, "red-skills-redskilled");
    await writeFile(shim, "resolves its bundle relative to itself");

    const shimEntry = { command: "/usr/bin/node", args: [shim], entry: shim };
    expect(stabilizeRedskilledEntry(shimEntry, { homeDir, version: "4.0.0" })).toEqual(shimEntry);

    const dispatch = { command: "/usr/local/bin/npx", args: ["-y", "-p", "@reddb-io/red-skills@4.0.0"] };
    expect(stabilizeRedskilledEntry(dispatch, { homeDir })).toEqual(dispatch);
    expect(existsSync(redskilledStableBundleDir(homeDir))).toBe(false);
  });

  it("loses only durability on a host without the daemon home", async () => {
    const { homeDir, sourceDir } = await scratch();
    await rm(join(homeDir, ".red", "redskilled"), { recursive: true });
    const source = join(sourceDir, "redskilled-4.0.0.bundle.min.mjs");
    await writeFile(source, "bytes");
    const entry = { command: "/usr/bin/node", args: [source], entry: source };

    // Amendment 2: this is not a home creator. The entry stays runnable as is.
    expect(stabilizeRedskilledEntry(entry, { homeDir })).toEqual(entry);
    expect(existsSync(join(homeDir, ".red", "redskilled"))).toBe(false);
  });
});

describe("the replacement resolver rides the stable home", () => {
  it("prefers an existing stable copy over every cache", async () => {
    const { homeDir, sourceDir } = await scratch();
    const stableDir = redskilledStableBundleDir(homeDir);
    await mkdir(stableDir, { recursive: true });
    const stable = join(stableDir, redskilledStableBundleName("4.2.0"));
    await writeFile(stable, "the durable copy");
    const cached = join(sourceDir, "redskilled-4.2.0.bundle.min.mjs");
    await writeFile(cached, "the prunable copy");

    const entry = requireRedskilledReplacementEntry("4.2.0", {
      env: { HOME: homeDir, RED_SKILLS_CACHE_DIR: sourceDir },
      callerEntry: "",
    });

    expect(entry.source).toBe("stable-home");
    expect(entry.args).toEqual([stable]);
  });

  it("stabilizes a cache hit on the way out, so the repoint writes the durable path", async () => {
    const { homeDir, sourceDir } = await scratch();
    const cached = join(sourceDir, "redskilled-4.3.0.bundle.min.mjs");
    await writeFile(cached, "published bytes");

    const entry = requireRedskilledReplacementEntry("4.3.0", {
      env: { HOME: homeDir, RED_SKILLS_CACHE_DIR: sourceDir },
      callerEntry: "",
    });

    const target = join(redskilledStableBundleDir(homeDir), redskilledStableBundleName("4.3.0"));
    expect(entry.source).toBe("bundle-cache");
    expect(entry.args).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe("published bytes");
  });
});
