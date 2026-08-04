import { describe, expect, it } from "vitest";
import {
  renewRegistrationDelivery,
  planRegistrationDeliveryRenewal,
  registrationBundleVersion,
  registrationDeliveryLanes,
} from "../src/runtime/registration-delivery.js";

const OLD = "3.3.24";
const PUBLISHED = "3.4.0";

const registration = {
  argv: [
    "/usr/bin/node",
    `/cache/dev-${OLD}.bundle.min.mjs`,
    "run",
    "--once",
    "--runner",
    "codex",
    "--selector",
    '{"lane":"afk"}',
  ],
  env: { RED_AFK_RUNNER: "codex", RED_AFK_WORKER_ID: "{{worker_id}}" },
  log_path: "/logs/{{worker_id}}.log",
};

describe("registration delivery reconciliation", () => {
  it("reads the engine version from both cached-bundle and pinned-dispatch argv", () => {
    expect(registrationBundleVersion(registration.argv)).toBe(OLD);
    expect(registrationBundleVersion([
      "npx",
      "-y",
      "-p",
      `@reddb-io/red-skills@${PUBLISHED}`,
      "red-skills-dev",
      "run",
      "--once",
    ])).toBe(PUBLISHED);
  });

  it("reports the published, registration-bundle and plugin-cache lanes together", () => {
    expect(registrationDeliveryLanes({
      registrationArgv: registration.argv,
      publishedVersion: PUBLISHED,
      pluginCacheVersion: "3.3.21",
    })).toEqual({
      published_version: PUBLISHED,
      bundle_version: OLD,
      plugin_cache_version: "3.3.21",
    });
  });

  it("re-points a superseded registration while preserving its work launch", () => {
    const nextHead = ["/usr/bin/node", `/cache/dev-${PUBLISHED}.bundle.min.mjs`];
    const plan = planRegistrationDeliveryRenewal({
      registration,
      publishedVersion: PUBLISHED,
      publishedArgv: nextHead,
    });

    expect(plan.action).toBe("repoint");
    expect(plan.launch).toEqual({
      argv: [...nextHead, ...registration.argv.slice(2)],
      env: registration.env,
      log_path: registration.log_path,
    });
    expect(plan.lanes.bundle_version).toBe(OLD);
    expect(plan.lanes.published_version).toBe(PUBLISHED);
  });

  it("renews without a launch revision when the registration is current", () => {
    const plan = planRegistrationDeliveryRenewal({
      registration: { ...registration, argv: ["/usr/bin/node", `/cache/dev-${PUBLISHED}.bundle.min.mjs`, ...registration.argv.slice(2)] },
      publishedVersion: PUBLISHED,
      publishedArgv: ["unused"],
    });

    expect(plan.action).toBe("renew");
    expect(plan.launch).toBeUndefined();
  });

  it("makes the published comparison part of the ordinary renewal", async () => {
    const calls: string[] = [];
    const result = await renewRegistrationDelivery({
      port: {
        registration: async () => ({ ...registration }),
        renew: async () => { calls.push("renew"); },
        restateLaunch: async (launch) => { calls.push(`repoint:${launch.argv[1]}`); },
      },
      publishedVersion: async () => PUBLISHED,
      publishedArgv: (version) => ["/usr/bin/node", `/cache/dev-${version}.bundle.min.mjs`],
      pluginCacheVersion: () => "3.3.21",
    });

    expect(result?.action).toBe("repoint");
    expect(calls).toEqual([`repoint:/cache/dev-${PUBLISHED}.bundle.min.mjs`]);
  });
});
