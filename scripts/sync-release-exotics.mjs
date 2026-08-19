#!/usr/bin/env node
// Release-standard extension for the two version carriers whose formats are
// not npm, Cargo, or a dedicated text file. The engine supplies the version and
// remains the only caller/writer for a release bump.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.env.RED_RELEASE_VERSION;
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("RED_RELEASE_VERSION must be a semver-compatible release version");
}

rewrite(
  "apps/herdr-plugin-redskilled/herdr-plugin.toml",
  /^version = "[^"]+"$/m,
  `version = "${version}"`,
);
rewrite(
  "apps/herdr-plugin-redskilled/bin/red-skills-herdr.mjs",
  /^const CHECKOUT_VERSION = "[^"]+";$/m,
  `const CHECKOUT_VERSION = "${version}";`,
);

function rewrite(path, pattern, replacement) {
  const source = readFileSync(path, "utf8");
  if (!pattern.test(source)) throw new Error(`${path} has no recognized version carrier`);
  writeFileSync(path, source.replace(pattern, replacement));
}
