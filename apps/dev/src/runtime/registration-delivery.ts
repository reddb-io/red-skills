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
  /**
   * Where this project's NEXT Worker logs, as the namer states it TODAY (#3440).
   *
   * Stated by the caller rather than carried from the registration, because the
   * registration's copy is whatever it said when it was first registered and a
   * registration is renewed for days. Carrying it forward is how a repoint that
   * exists to heal a stale registration went on re-stating the one stale fact it
   * held.
   */
  readonly logPath: string;
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
      log_path: input.logPath,
    },
  };
}

/** The narrow project-side port one delivery renewal needs. */
export interface RegistrationDeliveryPort {
  registration(): Promise<(RegistrationLaunchRecord & { readonly argv: readonly string[] }) | null>;
  renew(): Promise<unknown>;
  restateLaunch(launch: RedskilledLaunchTemplate): Promise<unknown>;
}

/**
 * Perform one renewal with delivery reconciliation attached.
 *
 * Registry silence costs only the comparison: the ordinary renewal still moves
 * the deadline. When publication is ahead, the resolved argv may be either a
 * warmed cache path or the version-pinned package fallback; both make the next
 * Worker run the published engine without an operator re-registering it.
 */
export async function renewRegistrationDelivery(input: {
  readonly port: RegistrationDeliveryPort;
  readonly publishedVersion: () => Promise<string | null | undefined>;
  readonly publishedArgv: (version: string) => readonly string[];
  readonly pluginCacheVersion?: () => string | null | undefined;
  /** Where this project's next Worker logs, as the namer states it today. */
  readonly logPath: string;
}): Promise<RegistrationDeliveryRenewal | null> {
  const registration = await input.port.registration();
  if (registration == null) return null;

  let published = "";
  try {
    published = (await input.publishedVersion()) ?? "";
  } catch {
    await input.port.renew();
    return null;
  }
  if (published === "") {
    await input.port.renew();
    return null;
  }

  const plan = planRegistrationDeliveryRenewal({
    registration,
    publishedVersion: published,
    publishedArgv: input.publishedArgv(published),
    pluginCacheVersion: input.pluginCacheVersion?.(),
    logPath: input.logPath,
  });
  if (plan.action === "repoint") await input.port.restateLaunch(plan.launch);
  else await input.port.renew();
  return plan;
}
