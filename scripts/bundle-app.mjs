#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.entry || !args.outfile || !args.asset) {
  process.stderr.write(
    "bundle-app: --entry, --outfile and --asset are required\n",
  );
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const version = (process.env.RED_BUILD_VERSION || pkg.version || "0.0.0-dev").replace(/^v/, "");
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

const result = spawnSync("esbuild", esbuildArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);

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
    else if (arg === "--minify") out.minify = true;
    else if (arg === "--reddb-from-package") out.reddbFromPackage = true;
    else {
      process.stderr.write(`bundle-app: unknown arg ${arg}\n`);
      process.exit(1);
    }
  }
  return out;
}
