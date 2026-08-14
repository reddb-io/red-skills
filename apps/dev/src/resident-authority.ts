import { join } from "node:path";
import { readBuildInfo } from "@reddb-io/build-info";
import {
  armPr,
  createEnginePaths,
  createFileIssueCuratorStore,
  createFileMergeDriverStore,
  createGitHubTrackerAdapter,
  createSingletonLeaseStore,
  runIssueStateCurator,
  runMergeDriverPass,
} from "@reddb-io/red-castle/engine";
import { HOST_STATE_TRANSITION_LABELS } from "./core/state-transition.js";
import { parseCurrentBlocker } from "./core/blocker-state.js";
import { createFileMedicStore, runMedicPass } from "./core/pr-medic.js";
import { newestInstalledPluginVersion, refreshPublishedBundleVersion } from "./core/published-version.js";
import { loadConfig, readStandingDrain } from "./core/config.js";
import { createMergeDriverIo } from "./runtime/merge-driver-io.js";
import { createDevGithubMergeRead } from "./runtime/github-merge-read.js";
import { createMedicIo } from "./runtime/medic-io.js";
import { resolveRepoContext } from "./runtime/wire.js";
import { createRedskilledBirthPort } from "./runtime/redskilled-birth.js";
import { publishedBundleArgv } from "./runtime/published-entry.js";
import { renewRegistrationDelivery } from "./runtime/registration-delivery.js";
import { maintainStandingDrain } from "./runtime/standing-drain.js";
import { workerLogPathTemplate } from "./runtime/redskilled-worker-log.js";
import { drain } from "./mcp/project.js";

const REGISTRATION_DELIVERY_RENEW_MS = 150_000;
export const RESIDENT_CURATOR_INTERVAL_MS = 5 * 60 * 1000;
export const RESIDENT_MERGE_DRIVER_INTERVAL_MS = 90 * 1000;

/** Keep the resident's standing registration pointed at the published engine. */
export function startResidentRegistrationDelivery(root: string): { stop(): void } {
  const tick = async () => {
    const port = createRedskilledBirthPort({ root });
    const installed = readBuildInfo("dev").version;
    await maintainStandingDrain({
      standing: () => readStandingDrain(loadConfig(join(root, ".red", "config.yaml"), {
        warn: () => undefined,
      })),
      registration: () => port.registration(),
      register: (standing) => drain(root, standing, { standing: true }),
      renew: () => renewRegistrationDelivery({
        port,
        publishedVersion: async () => (await refreshPublishedBundleVersion(installed)).version,
        publishedArgv: (version) => publishedBundleArgv({
          installedVersion: installed,
          resolvePublished: () => version,
        }),
        pluginCacheVersion: () => newestInstalledPluginVersion(),
        logPath: workerLogPathTemplate(root),
      }),
    });
  };
  void tick().catch(() => undefined);
  const timer = setInterval(() => void tick().catch(() => undefined), REGISTRATION_DELIVERY_RENEW_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** The recovery-only merge driver belongs to the heavy project authority. */
export async function startResidentMergeDriver(root = process.cwd()): Promise<void> {
  const paths = createEnginePaths(join(root, ".red"));
  const owner = { pid: process.pid, startTime: new Date().toISOString() };
  const lease = await createSingletonLeaseStore(paths).acquire("merge-driver", owner);
  if (!lease.acquired) return;

  const store = createFileMergeDriverStore(paths);
  let githubMergeRead: ReturnType<typeof createDevGithubMergeRead> | undefined;
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const state = await store.read();
      const armed = Object.values(state.prs).some((record) => record.status === "armed");
      if (armed) {
        const context = await resolveRepoContext(root);
        githubMergeRead ??= createDevGithubMergeRead(root, "resident:merge-driver");
        const entries = await runMergeDriverPass(
          createMergeDriverIo({ cwd: context.root, repo: context.repo }, githubMergeRead),
          store,
          { nowEpoch: Math.floor(Date.now() / 1000) },
        );
        for (const entry of entries) {
          if (entry.action !== "terminal-medic") continue;
          try {
            const medic = await runMedicPass(
              createMedicIo(context.root),
              createFileMedicStore(paths),
              entry.pr,
              { nowEpoch: Math.floor(Date.now() / 1000) },
            );
            if (medic.outcome === "healed") {
              await armPr(store, entry.pr, Math.floor(Date.now() / 1000));
            }
          } catch {
            // The terminal classification remains standing for the next owner.
          }
        }
      }
    } catch {
      // Transport faults retry on the resident's next interval.
    } finally {
      running = false;
    }
  };
  void pass();
  const timer = setInterval(() => void pass(), RESIDENT_MERGE_DRIVER_INTERVAL_MS);
  timer.unref();
}

/** Periodically reconcile quarantined Tickets from the one project resident. */
export async function startResidentIssueCurator(root = process.cwd()): Promise<void> {
  const paths = createEnginePaths(join(root, ".red"));
  const owner = { pid: process.pid, startTime: new Date().toISOString() };
  const lease = await createSingletonLeaseStore(paths).acquire("issue-curator", owner);
  if (!lease.acquired) return;

  const tracker = createGitHubTrackerAdapter({ claimLockRoot: join(paths.tmpRoot, "claims") });
  const store = createFileIssueCuratorStore(paths);
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runIssueStateCurator({
        tracker,
        store,
        labels: HOST_STATE_TRANSITION_LABELS,
        hasActiveCurrentBlocker: (body) => parseCurrentBlocker(body) !== null,
      });
    } catch {
      // Repo-level faults retry without terminating the resident.
    } finally {
      running = false;
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), RESIDENT_CURATOR_INTERVAL_MS);
  timer.unref();
}
