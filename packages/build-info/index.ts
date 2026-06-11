declare const __RED_BUILD_VERSION__: string | undefined;
declare const __RED_BUILD_GIT_SHA__: string | undefined;
declare const __RED_BUILD_TIME__: string | undefined;
declare const __RED_BUNDLE_ASSET__: string | undefined;
declare const __REDDB_SDK_VERSION__: string | undefined;
declare const __REDDB_BINARY_TAG__: string | undefined;

export interface BuildInfo {
  app: string;
  version: string;
  gitSha: string;
  buildTime: string;
  bundleAsset: string;
  reddbSdkVersion?: string;
  reddbBinaryTag?: string;
}

export function readBuildInfo(app: string): BuildInfo {
  const info: BuildInfo = {
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

function stripTagPrefix(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

export function renderVersion(info: BuildInfo): string {
  return `${info.app} ${info.version} ${info.gitSha}`;
}

function readInjected(name: string, read: () => string | undefined): string | undefined {
  try {
    const value = read();
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return process.env[name.replace(/^__|__$/g, "")];
  }
}
