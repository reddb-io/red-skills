#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));

if (!args.entry || !args.outfile || !args.asset) {
  process.stderr.write(
    "bundle-app: --entry, --outfile and --asset are required\n",
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

// The product has ONE version anchor — the same `apps/plugin-dev/package.json` that
// The Release standard updates SOURCE — and every bundle carries it.
//
// Reading the *cwd's* package.json instead was wrong for the bundles that ship
// inside the product without being published on their own: `rsp` sat at 2.23.1
// and `redskilled` at 0.1.0 while the product was at 2.88.x, so a locally built
// binary reported a version that corresponded to nothing. A release was correct
// only because RED_BUILD_VERSION overrode it — the fallback was the lie.
const PRODUCT_VERSION_ANCHOR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps/plugin-dev/package.json",
);
const anchorVersion = readAnchorVersion(PRODUCT_VERSION_ANCHOR);
const version = (process.env.RED_BUILD_VERSION || anchorVersion || pkg.version || "0.0.0-dev").replace(/^v/, "");

function readAnchorVersion(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8")).version;
  } catch {
    return undefined;
  }
}
const gitSha = process.env.RED_BUILD_GIT_SHA || "unknown";
const buildTime =
  process.env.RED_BUILD_TIME ||
  (process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString());

const defines = {
  __RED_BUILD_VERSION__: version,
  __RED_BUILD_GIT_SHA__: gitSha,
  __RED_BUILD_TIME__: buildTime,
  __RED_BUNDLE_ASSET__: args.asset,
  __REDDB_SDK_VERSION__: "",
  __REDDB_BINARY_TAG__: "",
};

if (args.lazyAssetEntry || args.lazyAsset) {
  if (!args.lazyAssetEntry || !args.lazyAsset) {
    process.stderr.write(
      "bundle-app: --lazy-asset-entry and --lazy-asset must be provided together\n",
    );
    process.exit(1);
  }
  defines.__RED_LAZY_ASSET__ = args.lazyAsset;
}

if (args.reddbFromPackage) {
  const sdk = pkg.dependencies?.["@reddb-io/sdk"];
  if (!sdk) {
    process.stderr.write("bundle-app: --reddb-from-package requires @reddb-io/sdk dependency\n");
    process.exit(1);
  }
  defines.__REDDB_SDK_VERSION__ = sdk;
  defines.__REDDB_BINARY_TAG__ = `v${sdk.replace(/^v/, "")}`;
}

const esbuildArgs = [
  args.entry,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  ...Object.entries(defines).map(([key, value]) => `--define:${key}=${JSON.stringify(value)}`),
  `--outfile=${args.outfile}`,
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
];

if (args.minify) esbuildArgs.splice(2, 0, "--minify");

// `--inputs-out` makes the BUNDLER declare what it consumed.
//
// The vendored release engine records the modules it was built from so a guard
// can check it without rebuilding (#4282). Deriving that list by walking a
// directory over-collects — a package's untouched siblings and its tests are not
// in the bundle — and hand-keeping it rots. esbuild already knows the exact set,
// so ask it: `--metafile` names every input, and the first-party ones (anything
// outside node_modules) are the closure worth recording.
const metafilePath = args.inputsOut
  ? resolve(mkdtempSync(resolve(tmpdir(), "red-bundle-meta-")), "meta.json")
  : undefined;
if (metafilePath) esbuildArgs.push(`--metafile=${metafilePath}`);

const result = spawnSync("esbuild", esbuildArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.status !== 0) process.exit(result.status ?? 1);

if (metafilePath) {
  writeInputsList(metafilePath, args.inputsOut);
  rmSync(dirname(metafilePath), { recursive: true, force: true });
}

if (args.lazyAssetEntry) {
  const lazyAssetArgs = [
    args.lazyAssetEntry,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    `--outfile=${resolve(dirname(args.outfile), args.lazyAsset)}`,
  ];
  if (args.minify) lazyAssetArgs.splice(2, 0, "--minify");

  const lazyAssetResult = spawnSync("esbuild", lazyAssetArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (lazyAssetResult.status !== 0) process.exit(lazyAssetResult.status ?? 1);
}

process.exit(0);

/**
 * Write the bundle's first-party inputs as newline-delimited repo-relative paths.
 *
 * Plain text on purpose: the consumers are a TypeScript guard and a refresher
 * under `apps/`, where the serialization doctrine keeps structured payloads off
 * JSON — a one-column list needs no structure at all.
 */
function writeInputsList(metafile, outfile) {
  const meta = JSON.parse(readFileSync(metafile, "utf8"));
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const inputs = Object.keys(meta.inputs ?? {})
    .filter((input) => !input.split("/").includes("node_modules"))
    .map((input) => relative(repoRoot, resolve(input)).split(sep).join("/"))
    .sort();
  writeFileSync(outfile, `${inputs.join("\n")}\n`, "utf8");
}

function parseArgs(argv) {
  const out = {
    minify: false,
    reddbFromPackage: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--entry") out.entry = argv[++i];
    else if (arg === "--outfile") out.outfile = argv[++i];
    else if (arg === "--asset") out.asset = argv[++i];
    else if (arg === "--inputs-out") out.inputsOut = argv[++i];
    else if (arg === "--lazy-asset-entry") out.lazyAssetEntry = argv[++i];
    else if (arg === "--lazy-asset") out.lazyAsset = argv[++i];
    else if (arg === "--minify") out.minify = true;
    else if (arg === "--reddb-from-package") out.reddbFromPackage = true;
    else {
      process.stderr.write(`bundle-app: unknown arg ${arg}\n`);
      process.exit(1);
    }
  }
  return out;
}
