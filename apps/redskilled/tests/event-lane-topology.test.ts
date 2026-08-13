import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedskilledEventLane, followRedskilledPublicEvents } from "../src/event-lane.js";
import { buildHostState } from "../src/host-state.js";
import type { RedskilledHostTopology } from "../src/host-topology.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const wsl: RedskilledHostTopology = { platform: "linux", environment: "wsl" };
const windows: RedskilledHostTopology = { platform: "win32", environment: "native" };

describe("a public host-event consumer's first attach", () => {
  it("refuses only cross-WSL topologies before handing the consumer a watch position", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-event-topology-"));
    roots.push(root);
    const path = join(root, "redskilled.log.toonl");
    const lane = createRedskilledEventLane(path);
    const sameSide: Array<readonly [RedskilledHostTopology, RedskilledHostTopology, NonNullable<Awaited<ReturnType<typeof followRedskilledPublicEvents>>["position"]>]> = [];

    await lane.recordWorker({
      kind: "worker-birth",
      worker: {
        worker_id: "wBASE",
        project_label: "acme/widgets",
        pid: 41,
        started_at: "2026-08-13T00:00:00.000Z",
        workspace_path: "/tmp/workspace",
        isolated: false,
        warnings: [],
      },
      ts: "2026-08-13T00:00:00.000Z",
    });

    for (const [daemon, consumer, status] of [
      [wsl, windows, "refused"],
      [windows, wsl, "refused"],
      [wsl, wsl, "baseline"],
      [windows, windows, "baseline"],
    ] as const) {
      const followed = await followRedskilledPublicEvents(
        path,
        null,
        async () => buildHostState({
          daemonVersion: "3.18.1",
          machineIdHash: "machine",
          sessionKeyHash: "session",
          pid: 42,
          startedAt: "2026-08-13T00:00:00.000Z",
          topology: daemon,
        }),
        { consumerTopology: consumer },
      );

      expect(followed.status).toBe(status);
      if (followed.status === "refused") {
        expect(followed.position).toBeNull();
        expect(followed.events).toEqual([]);
        expect(followed.detail).toMatch(/file-change notification does not cross the WSL boundary/);
        expect(followed.topology).toMatch(/wsl.*native-windows|native-windows.*wsl/);
      } else if (followed.status === "baseline" && followed.position != null) {
        sameSide.push([daemon, consumer, followed.position]);
      }
    }

    await lane.recordWorker({
      kind: "worker-birth",
      worker: {
        worker_id: "wNEXT",
        project_label: "acme/widgets",
        pid: 43,
        started_at: "2026-08-13T00:01:00.000Z",
        workspace_path: "/tmp/workspace",
        isolated: false,
        warnings: [],
      },
      ts: "2026-08-13T00:01:00.000Z",
    });
    for (const [daemon, consumer, position] of sameSide) {
      const followed = await followRedskilledPublicEvents(
        path,
        position,
        async () => ({ topology: daemon }),
        { consumerTopology: consumer },
      );
      expect(followed.status).toBe("events");
      expect(followed.events.map((event) => event.worker_id)).toEqual(["wNEXT"]);
    }
  });
});
