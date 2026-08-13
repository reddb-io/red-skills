import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { REDSKILLED_BUNDLE_ASSET } from "../src/daemon-entry.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { planRedskilledUnit } from "../src/supervision.js";

/**
 * A unit outlives every cache it was installed from.
 *
 * The operator-facing install runs through `npx`, which hands the daemon an
 * entry inside `~/.npm/_npx/<hash>/` — a directory npm prunes on its own
 * schedule. An `ExecStart` naming that path is a daemon that stops starting for
 * a reason nothing on the machine explains, and the failure surfaces at the
 * worst moment: after a reboot, when the operator is not watching.
 *
 * The stabilizer that copies such a bundle into `~/.red/redskilled/bundles/`
 * already existed. What it lacked was the version — the one argument that lets
 * it name a destination — because the npx entry is always the UNVERSIONED asset
 * name and the caller never stated one. No test asserted the installed target
 * was durable, so the entry went out pointing at the cache and nothing objected.
 */
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A host whose resolved entry sits in a prunable npx cache, as `npx` delivers it. */
async function npxHost(): Promise<{ paths: ReturnType<typeof resolveRedskilledPaths>; cacheEntry: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-durable-"));
  roots.push(root);

  // The shape npx produces: a hashed cache directory, and the bundle inside it
  // carrying the plain asset name with no version anywhere in the path.
  const cache = join(root, ".npm", "_npx", "71151dc9e0daee0b", "node_modules", "@reddb-io", "red-skills", "dist");
  await mkdir(cache, { recursive: true });
  const cacheEntry = join(cache, REDSKILLED_BUNDLE_ASSET);
  await writeFile(cacheEntry, "// bundle", { mode: 0o755 });

  // The daemon home must already exist: this provisions nothing (ADR 0130
  // Amendment 2), it only copies into a home somebody else created.
  await mkdir(join(root, ".red", "redskilled"), { recursive: true });

  const paths = resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
  return { paths, cacheEntry, home: root };
}

describe("an installed unit points somewhere durable", () => {
  it("copies a cache-resident bundle into the daemon home before naming it", async () => {
    const { paths, cacheEntry, home } = await npxHost();

    const plan = planRedskilledUnit(paths, {
      env: { HOME: home },
      entryLookup: { callerEntry: cacheEntry, execPath: "/usr/bin/node", execArgv: [] },
      version: "3.18.2",
    });

    expect(plan.text).not.toContain("_npx");
    expect(plan.args.some((arg) => arg.includes(join(".red", "redskilled", "bundles")))).toBe(true);
    expect(plan.args.some((arg) => arg.endsWith("redskilled-3.18.2.bundle.min.mjs"))).toBe(true);
  });

  it("leaves the entry alone when no version can name a destination", async () => {
    // A local build is not a point on the published lane, so there is nothing to
    // copy it AS. Using it as resolved is correct — durability is an upgrade,
    // never a precondition, and taking a developer's own daemon away mid-session
    // would be the worse failure.
    const { paths, cacheEntry, home } = await npxHost();

    const plan = planRedskilledUnit(paths, {
      env: { HOME: home },
      entryLookup: { callerEntry: cacheEntry, execPath: "/usr/bin/node", execArgv: [] },
    });

    expect(plan.args).toContain(cacheEntry);
  });
});
