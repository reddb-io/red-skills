/**
 * `packages/shared` — code common to two or more `apps/*` plugins (ADR 0034, relocated by ADR 0060).
 *
 * Re-exports the shared CLI argument layer built over `cli-args-parser`.
 */
export {
  extractFlags,
  parseFlags,
  parseLooseArgs,
  routeCommand,
  UnknownCommandError,
  type ExtractFlagsResult,
  type BooleanFlagSpec,
  type ValueFlagSpec,
  type FlagSpec,
  type FlagSchema,
  type ParseFlagsResult,
  type LooseParsedArgs,
  type RoutedCommand,
  type CommandSpec,
  type RouterSchema,
} from "./args.js";
export * from "./log.js";
export {
  CANONICAL_VERSION_PLACEHOLDER,
  canonicalInvocation,
  type ShippedBinary,
} from "./canonical-invocation.js";
export * from "./github-webhook.js";
export {
  CANARY_TAG,
  CHANNEL_ENV_VAR,
  DEFAULT_CHANNEL,
  RELEASE_CHANNELS,
  channelReleaseRef,
  normalizeChannel,
  resolveChannel,
  type ReleaseChannel,
  type ResolveChannelOptions,
} from "./channel.js";
export {
  backgroundSelfUpdate,
  compareSemver,
  isInRange,
  parseSemver,
  pointerFileName,
  pointerPath,
  resolveActiveVersion,
  selectInRangeUpdate,
  type ResolveActiveVersionInput,
  type SelfUpdateInput,
  type SelfUpdateIO,
  type SelfUpdateResult,
  type SelfUpdateStatus,
  type Semver,
} from "./self-update.js";
export {
  BundleFetchError,
  CANARY_DIST_TAG,
  NPM_PACKAGE,
  NPM_REGISTRY_BASE,
  bundleFileName,
  ensureBundle,
  fetchNewestSameMajor,
  fetchPublishedVersionHorizon,
  newestPublished,
  newestSameMajor,
  npmPackageSpec,
  packagedBundleName,
  packagedBundleRelPath,
  parseRegistryVersions,
  registryDistTagVersion,
  registryPackageUrl,
  resolveBundle,
  type BundleIO,
  type BundleFetchFailure,
  type EnsureBundleInput,
  type PublishedVersionHorizon,
  type ResolveBundleInput,
} from "./bundle-fetch.js";
export {
  REDDB_REPO,
  RED_RELEASE_BASE,
  RED_RUNTIME_DIR,
  RedRuntimeError,
  ensureRedBinary,
  parseSha256File,
  redAssetName,
  redAssetUrl,
  redBinaryFileName,
  redPlatformKey,
  redRuntimeDir,
  resolveCachedRedBinary,
  resolveRedBinaryPath,
  type EnsureRedBinaryInput,
  type RedBinaryRuntime,
  type RedRuntimeIO,
} from "./red-runtime.js";
export * from "./engine-node.js";
export * from "./red-paths.js";
export * from "./repo-root.js";
export * from "./outcome-event.js";
export * from "./resident-client.js";
export * from "./resident-protocol.js";
export * from "./toon-migration.js";
