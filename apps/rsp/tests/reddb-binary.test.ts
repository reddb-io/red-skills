// #4196: the bundled resident could not find the `red` engine binary.
//
// esbuild inlines `@reddb-io/sdk`, so the SDK's own `<package>/bin/red` probe —
// derived from its module URL — resolved against the BUNDLE's directory and
// landed on `<repo>/bin/red`. These specs pin the replacement cascade in both
// directions: which step answers, and that an earlier step always wins.
import { describe, expect, it } from "vitest";
import { reddbBinaryFileName, resolveReddbBinary, type ReddbBinaryLookup } from "../src/reddb-binary.js";

const REPO = "/repo";
const BUNDLE_DIR = `${REPO}/dist`;
const SDK_BIN = `${REPO}/node_modules/@reddb-io/sdk/bin/red`;
const PNPM_SDK_BIN = `${REPO}/node_modules/.pnpm/node_modules/@reddb-io/sdk/bin/red`;
const CACHE = "/cache/red-skills/bundles";
const PATH_BIN = "/usr/local/bin/red";

function lookup(present: string[], env: NodeJS.ProcessEnv = {}, over: Partial<ReddbBinaryLookup> = {}): ReddbBinaryLookup {
  const set = new Set(present);
  return {
    env: { PATH: "/usr/local/bin:/usr/bin", RED_SKILLS_CACHE_DIR: CACHE, ...env },
    fromDir: BUNDLE_DIR,
    cwd: "/somewhere/else",
    platform: "linux",
    home: "/home/nobody",
    exists: (path) => set.has(path),
    listDir: (path) => path === `${CACHE}/reddb` ? ["1.20.0", "1.23.2", "1.9.0"] : [],
    ...over,
  };
}

describe("reddb binary resolution (#4196)", () => {
  it("takes REDDB_BIN verbatim, without probing it", () => {
    // An override that points at nothing must reach the SDK so its own
    // "binary not found" error names the bad path — never a silent substitute.
    const resolved = resolveReddbBinary(lookup([SDK_BIN, PATH_BIN], { REDDB_BIN: "/opt/handpicked/red" }));
    expect(resolved).toEqual({ path: "/opt/handpicked/red", source: "env" });
  });

  it("ignores an empty REDDB_BIN and continues down the cascade", () => {
    const resolved = resolveReddbBinary(lookup([SDK_BIN], { REDDB_BIN: "" }));
    expect(resolved).toEqual({ path: SDK_BIN, source: "sdk-package" });
  });

  it("finds the SDK package from a bundle that sits above the node_modules tree", () => {
    // The regression: `fromDir` is the bundle's dir, not the SDK package's.
    const resolved = resolveReddbBinary(lookup([SDK_BIN]));
    expect(resolved).toEqual({ path: SDK_BIN, source: "sdk-package" });
  });

  it("finds the SDK package in the pnpm hoist directory Node never walks to", () => {
    const resolved = resolveReddbBinary(lookup([PNPM_SDK_BIN]));
    expect(resolved).toEqual({ path: PNPM_SDK_BIN, source: "sdk-package" });
  });

  it("falls to the warm cache, newest version first, when no package is installed", () => {
    const resolved = resolveReddbBinary(lookup([`${CACHE}/reddb/1.20.0/red`, `${CACHE}/reddb/1.23.2/red`]));
    expect(resolved).toEqual({ path: `${CACHE}/reddb/1.23.2/red`, source: "warm-cache" });
  });

  it("defaults an unset RED_SKILLS_CACHE_DIR to the standard cache, not to 'no cache'", () => {
    const home = "/home/nobody";
    const cached = `${home}/.cache/red-skills/bundles/reddb/1.23.2/red`;
    const resolved = resolveReddbBinary(lookup([cached], { RED_SKILLS_CACHE_DIR: undefined }, {
      listDir: (path) => path === `${home}/.cache/red-skills/bundles/reddb` ? ["1.23.2"] : [],
    }));
    expect(resolved).toEqual({ path: cached, source: "warm-cache" });
  });

  it("probes PATH only as the last resort", () => {
    const resolved = resolveReddbBinary(lookup([PATH_BIN]));
    expect(resolved).toEqual({ path: PATH_BIN, source: "path" });
  });

  it("orders the whole cascade env > sdk-package > warm-cache > path", () => {
    const everything = [SDK_BIN, PNPM_SDK_BIN, `${CACHE}/reddb/1.23.2/red`, PATH_BIN];
    const order: Array<[string[], NodeJS.ProcessEnv, unknown]> = [
      [everything, { REDDB_BIN: "/opt/handpicked/red" }, { path: "/opt/handpicked/red", source: "env" }],
      [everything, {}, { path: SDK_BIN, source: "sdk-package" }],
      [everything.slice(2), {}, { path: `${CACHE}/reddb/1.23.2/red`, source: "warm-cache" }],
      [everything.slice(3), {}, { path: PATH_BIN, source: "path" }],
    ];
    for (const [present, env, expected] of order) {
      expect(resolveReddbBinary(lookup(present, env)), JSON.stringify(expected)).toEqual(expected);
    }
  });

  it("answers null when no step of the cascade finds a binary", () => {
    // Legal: the caller leaves REDDB_BIN unset and the SDK raises its own
    // actionable error rather than rsp guessing a path that does not exist.
    expect(resolveReddbBinary(lookup([]))).toBeNull();
  });

  it("asks for red.exe on Windows", () => {
    expect(reddbBinaryFileName("win32")).toBe("red.exe");
    expect(reddbBinaryFileName("linux")).toBe("red");
    const win = `${REPO}/node_modules/@reddb-io/sdk/bin/red.exe`;
    expect(resolveReddbBinary(lookup([win], {}, { platform: "win32" }))).toEqual({ path: win, source: "sdk-package" });
  });
});
