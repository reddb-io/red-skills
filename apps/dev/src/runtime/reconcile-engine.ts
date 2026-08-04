import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveBundle } from "@reddb-io/shared/bundle-fetch.js";
import { redSkillsCacheDir } from "../core/bundle-version.js";
import {
  renewRegistrationDelivery,
  type RegistrationDeliveryPort,
} from "./registration-delivery.js";
import { createRedskilledBirthPort } from "./redskilled-birth.js";

export interface ReconcileEngineDeliveryOptions {
  readonly root: string;
  readonly version: string;
  readonly sourceBundle?: string;
  readonly cacheDir?: string;
  readonly execPath?: string;
  readonly port?: RegistrationDeliveryPort;
}
export interface ReconcileEngineDeliveryResult {
  readonly version: string;
  readonly bundle_path: string;
  readonly registration: "repointed" | "renewed" | "absent";
}

/**
 * Warm the exact engine executing this command, then point the registration at
 * that stable cache path in the same invocation.
 */
export async function reconcileEngineDelivery(
  options: ReconcileEngineDeliveryOptions,
): Promise<ReconcileEngineDeliveryResult> {
  const source = options.sourceBundle ?? process.argv[1] ?? "";
  if (source === "") throw new Error("reconcile-engine cannot locate the dev bundle executing it");
  const cacheDir = options.cacheDir ?? redSkillsCacheDir();
  const bundlePath = resolveBundle({ plugin: "dev", version: options.version, cacheDir });
  await mkdir(dirname(bundlePath), { recursive: true });
  await copyFile(source, bundlePath);

  const renewal = await renewRegistrationDelivery({
    port: options.port ?? createRedskilledBirthPort({ root: options.root }),
    publishedVersion: async () => options.version,
    publishedArgv: () => [options.execPath ?? process.execPath, bundlePath],
  });
  return {
    version: options.version,
    bundle_path: bundlePath,
    registration: renewal == null ? "absent" : renewal.action === "repoint" ? "repointed" : "renewed",
  };
}
