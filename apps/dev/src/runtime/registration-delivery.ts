/**
 * registration-delivery — the versioned journey from publication to the argv a
 * registration will use for its next Worker.
 *
 * The host daemon deliberately carries argv opaquely. Reconciliation therefore
 * belongs on the project-side renewal: it compares explicit version facts,
 * resolves a published argv head, and restates the complete launch. The daemon
 * still reads none of the words it stores.
 */
import type { RedskilledLaunchTemplate } from "@reddb-io/redskilled/launch-template";
import { compareSemver } from "../core/bundle-version.js";

const VERSION = "\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?";
const CACHE_BUNDLE = new RegExp(`(?:^|[/\\\\])dev-(${VERSION})\\.bundle\\.min\\.mjs$`);
const PINNED_PACKAGE = new RegExp(`^@reddb-io/red-skills@(${VERSION})$`);

export interface RegistrationDeliveryLanes {
  readonly published_version: string;
  readonly bundle_version: string;
  readonly plugin_cache_version: string;
}

export interface RegistrationLaunchRecord {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly log_path?: string;
}

export type RegistrationDeliveryRenewal =
  | {
    readonly action: "renew";
    readonly lanes: RegistrationDeliveryLanes;
    readonly launch?: undefined;
  }
  | {
    readonly action: "repoint";
    readonly lanes: RegistrationDeliveryLanes;
    readonly launch: RedskilledLaunchTemplate;
  };

/** Read the engine version the registration argv explicitly names. */
export function registrationBundleVersion(argv: readonly string[]): string {
  for (const word of argv) {
    const cached = CACHE_BUNDLE.exec(word);
    if (cached?.[1]) return cached[1];
    const pinned = PINNED_PACKAGE.exec(word);
    if (pinned?.[1]) return pinned[1];
  }
  return "";
}

/** The three independently moving delivery lanes, in one report. */
export function registrationDeliveryLanes(input: {
  readonly registrationArgv?: readonly string[];
  readonly publishedVersion?: string | null;
  readonly pluginCacheVersion?: string | null;
}): RegistrationDeliveryLanes {
  return {
    published_version: input.publishedVersion ?? "",
    bundle_version: registrationBundleVersion(input.registrationArgv ?? []),
    plugin_cache_version: input.pluginCacheVersion ?? "",
  };
}

/**
 * Plan one ordinary renewal, re-pointing only when publication is newer.
 *
 * `run --once` is the stable boundary between the versioned argv head and the
 * project's work launch. If an older or foreign registration does not carry
 * that boundary, renewal remains safe and leaves it untouched rather than
 * guessing where its opaque argv should be cut.
 */
export function planRegistrationDeliveryRenewal(input: {
  readonly registration: RegistrationLaunchRecord;
  readonly publishedVersion: string;
  readonly publishedArgv: readonly string[];
  readonly pluginCacheVersion?: string | null;
}): RegistrationDeliveryRenewal {
  const lanes = registrationDeliveryLanes({
    registrationArgv: input.registration.argv,
    publishedVersion: input.publishedVersion,
    pluginCacheVersion: input.pluginCacheVersion,
  });
  if (
    lanes.bundle_version === "" ||
    compareSemver(input.publishedVersion, lanes.bundle_version) <= 0
  ) {
    return { action: "renew", lanes };
  }

  const workIndex = input.registration.argv.findIndex(
    (word, index, argv) => word === "run" && argv[index + 1] === "--once",
  );
  if (workIndex < 0 || input.publishedArgv.length === 0) {
    return { action: "renew", lanes };
  }

  return {
    action: "repoint",
    lanes,
    launch: {
      argv: [...input.publishedArgv, ...input.registration.argv.slice(workIndex)],
      env: input.registration.env,
      ...(input.registration.log_path == null ? {} : { log_path: input.registration.log_path }),
    },
  };
}

