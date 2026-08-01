/**
 * The declared surface of `index.mjs` — hand-written because the implementation
 * is plain ESM (see the header there for why it has to be).
 */
export interface BuildInfo {
  app: string;
  version: string;
  gitSha: string;
  buildTime: string;
  bundleAsset: string;
  reddbSdkVersion?: string;
  reddbBinaryTag?: string;
}

export declare function readBuildInfo(app: string): BuildInfo;

export declare function renderVersion(info: BuildInfo): string;
