/**
 * build-info — the version answer every shipped binary owes, read off the stamp.
 *
 * **Plain ESM on purpose, with the types beside it in `index.d.mts`.** The module
 * used to be `index.ts`, which every bundled app compiled and no plain-ESM binary
 * could load: Node refuses to strip types from a file under `node_modules`, and a
 * workspace link IS under `node_modules`. That left a binary shipped as `.mjs` —
 * `apps/herdr-plugin` is the first — with no way to reach the one function the
 * shipped-binary invariant asks it to call. The implementation carries no types
 * worth compiling, so it moved to the extension both consumers can read.
 *
 * The values come from identifiers a bundler DEFINES into the artifact, which is
 * the whole point rather than an implementation detail: `--version` is asked of a
 * binary that is misbehaving, precisely when the config is wrong, the store is
 * missing or the socket is dead. An answer assembled from any of those is
 * unavailable exactly when it is needed. Unbundled — a checkout run — the
 * identifiers are undeclared, the read throws, and the env fallback answers.
 */

/**
 * @typedef {object} BuildInfo
 * @property {string} app
 * @property {string} version
 * @property {string} gitSha
 * @property {string} buildTime
 * @property {string} bundleAsset
 * @property {string} [reddbSdkVersion]
 * @property {string} [reddbBinaryTag]
 */

/**
 * The build identity of `app`, from the stamp the bundler defined into it.
 *
 * @param {string} app
 * @returns {BuildInfo}
 */
export function readBuildInfo(app) {
  /** @type {BuildInfo} */
  const info = {
    app,
    version: stripTagPrefix(readInjected("__RED_BUILD_VERSION__", () => __RED_BUILD_VERSION__) ?? "0.0.0-dev"),
    gitSha: readInjected("__RED_BUILD_GIT_SHA__", () => __RED_BUILD_GIT_SHA__) ?? "unknown",
    buildTime: readInjected("__RED_BUILD_TIME__", () => __RED_BUILD_TIME__) ?? "unknown",
    bundleAsset: readInjected("__RED_BUNDLE_ASSET__", () => __RED_BUNDLE_ASSET__) ?? "unknown",
  };
  const reddbSdkVersion = readInjected("__REDDB_SDK_VERSION__", () => __REDDB_SDK_VERSION__);
  const reddbBinaryTag = readInjected("__REDDB_BINARY_TAG__", () => __REDDB_BINARY_TAG__);
  if (reddbSdkVersion) info.reddbSdkVersion = reddbSdkVersion;
  if (reddbBinaryTag) info.reddbBinaryTag = reddbBinaryTag;
  return info;
}

/**
 * @param {string} version
 * @returns {string}
 */
function stripTagPrefix(version) {
  return version.startsWith("v") ? version.slice(1) : version;
}

/**
 * The one line every binary prints for `--version`.
 *
 * @param {BuildInfo} info
 * @returns {string}
 */
export function renderVersion(info) {
  return `${info.app} ${info.version} ${info.gitSha}`;
}

/**
 * @param {string} name
 * @param {() => string | undefined} read
 * @returns {string | undefined}
 */
function readInjected(name, read) {
  try {
    const value = read();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return process.env[name.replace(/^__|__$/g, "")];
  }
}
