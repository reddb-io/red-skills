import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  createRedskilledEventLane,
  readRedskilledEvents,
} from "../src/event-lane.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildProjectRegistration,
  type RedskilledProjectRegistrationRequest,
} from "../src/project-registration.js";
import { createRedskilledRegistrationIntentStore } from "../src/registration-intent-store.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-registration-recovery-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
    homeDir: root,
  });
}

function request(
  projectLabel: string,
  overrides: Partial<RedskilledProjectRegistrationRequest> = {},
): RedskilledProjectRegistrationRequest {
  return {
    project_label: projectLabel,
    selector: "is:open label:ready-for-agent",
    argv: ["red-skills-dev", "run"],
    workspace_path: `/tmp/${projectLabel}`,
    target: 1,
    renew_within_ms: 600_000,
    ...overrides,
  };
}

describe("registration recovery after silent daemon death", () => {
  it("keeps live intent, releases abandoned intent, and records exactly what boot recovered", async () => {
    const paths = await sessionPaths();
    const intent = createRedskilledRegistrationIntentStore(paths.registrationIntentPath);
    const lane = createRedskilledEventLane(paths.eventLanePath);
    const bootedAt = "2026-08-11T14:08:00.000Z";

    const live = buildProjectRegistration(request("acme/live"), {
      now: "2026-08-11T14:06:00.000Z",
    });
    const abandoned = buildProjectRegistration(request("acme/abandoned"), {
      now: "2026-08-11T14:02:00.000Z",
    });
    await intent.replace([live, abandoned]);
    await lane.recordDaemonStart({
      ts: "2026-08-11T14:02:00.000Z",
      pid: 4100,
      socketPath: paths.socketPath,
      detail: "redskilled started and recovered no registrations",
    });

    const successor = await startRedskilledDaemon({
      paths,
      clock: () => bootedAt,
      sampleMs: 0,
      demandMs: 0,
      registrationSustainMs: 0,
      unitInventory: () => [],
    });
    running.push(successor);

    expect(successor.hostState().registrations?.map((entry) => entry.project_label)).toEqual(["acme/live"]);
    expect(successor.hostState().lapsed_registrations?.map((entry) => entry.project_label)).toEqual([
      "acme/abandoned",
    ]);
    expect(() => successor.registerProject(request("acme/abandoned"))).not.toThrow();

    await successor.flushEvents();
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.slice(-2).map((event) => event.kind)).toEqual(["daemon-death", "daemon-start"]);
    expect(events.at(-2)).toMatchObject({
      pid: 4100,
      reason: "silent-death",
    });
    expect(events.at(-1)?.detail).toContain(
      "registration intent store: recovered 1 live, lapsed 1 abandoned",
    );
  });
});
