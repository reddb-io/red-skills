#!/usr/bin/env node
import { createHash } from "node:crypto";
import { statSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const version = (process.env.RED_RELEASE_VERSION || process.env.RED_BUILD_VERSION || "").replace(/^v/, "");
const gitSha = process.env.RED_RELEASE_GIT_SHA || process.env.RED_BUILD_GIT_SHA || "unknown";

if (!version) {
  process.stderr.write("release-manifest: RED_RELEASE_VERSION is required\n");
  process.exit(1);
}

const paths = process.argv.slice(2);
if (paths.length === 0) {
  process.stderr.write("release-manifest: pass asset paths to include\n");
  process.exit(1);
}

const assets = paths.map((path) => {
  const bytes = readFileSync(path);
  return {
    name: basename(path),
    path,
    size: statSync(path).size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
});

const manifest = {
  schema: "red.release-manifest.v1",
  version,
  git_sha: gitSha,
  generated_at: new Date().toISOString(),
  assets,
};

writeFileSync("dist/release-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`release manifest: ${assets.length} assets for ${version}\n`);
