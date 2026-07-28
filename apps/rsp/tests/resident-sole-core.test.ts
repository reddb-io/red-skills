// ADR 0126, Spec #2651 slice 2: the resident is the core, every surface is a client.
//
// The behavioural proof lives in surface-parity.test.ts. This spec guards the
// structure that makes it hold: a surface that grows its own `RspElisionStore`
// is a second core, and the parity assertions would only notice once the two
// cores had already disagreed. Checking the source is the cheap, early alarm.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(__dirname, "..", "src");

/**
 * The two places allowed to open the store, and why.
 *
 * `elision-store/store.ts` — the store defines itself, including the one-shot
 * provisioning open that has to happen before any resident can exist.
 * `resident-server.ts` — the resident: the only *running* owner of the file.
 */
const STORE_OWNERS = new Set([
  join("elision-store", "store.ts"),
  "resident-server.ts",
]);

const STORE_OPEN = /\bRspElisionStore\.open\s*\(|\bnew\s+RspElisionStore\s*\(/;

describe("resident sole core (ADR 0126)", () => {
  it("opens the elision store nowhere but the store module and the resident", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcRoot)) {
      const rel = relative(srcRoot, file);
      if (STORE_OWNERS.has(rel)) continue;
      if (STORE_OPEN.test(await readFile(file, "utf8"))) offenders.push(rel.split(sep).join("/"));
    }
    expect(offenders, "these surfaces open their own store instead of asking the resident").toEqual([]);
  });

  it("keeps both declared owners honest — the allowlist names real openers", async () => {
    for (const owner of STORE_OWNERS) {
      expect(STORE_OPEN.test(await readFile(join(srcRoot, owner), "utf8")), owner).toBe(true);
    }
  });

  it("gives every surface the same resident client, from one factory", async () => {
    // A surface that hand-rolls the config mapping drifts the moment a knob is
    // added, so the client is minted in exactly one module.
    const offenders: string[] = [];
    for (const file of await sourceFiles(srcRoot)) {
      const rel = relative(srcRoot, file).split(sep).join("/");
      if (rel === "resident-store.ts") continue;
      if (/\bnew\s+ResidentRspElisionStore\s*\(/.test(await readFile(file, "utf8"))) offenders.push(rel);
    }
    expect(offenders, "construct the resident client through residentElisionStore()").toEqual([]);
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}
