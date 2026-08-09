import { describe, expect, it, vi } from "vitest";
import {
  describeRedskilledPresence,
  RedskilledUnreachableError,
} from "@reddb-io/redskilled/client";
import {
  requestWorkerBirth,
  type WorkerBirthPort,
} from "../src/runtime/mcp-worker-birth.js";

describe("the dispatch launcher's birth attribution", () => {
  it("replays the 2026-08-09 granted Worker as a boot refusal, not daemon unreachability", async () => {
    const socketPath = "/run/redskilled.sock";
    const transportFailure = new RedskilledUnreachableError(
      socketPath,
      new Error("request timed out"),
      describeRedskilledPresence({
        socketPath,
        answers: false,
        lease: {
          version: 1,
          pid: 35_290,
          start_time: "2026-08-09T01:55:00.000Z",
          session_key_hash: "session",
          machine_id_hash: "machine",
          socket_path: socketPath,
          acquired_at: "2026-08-09T01:55:00.000Z",
          renewed_at: "2026-08-09T02:10:00.000Z",
        },
        holderAlive: true,
        now: "2026-08-09T02:10:21.000Z",
      }),
    );
    const drainEvents = vi
      .fn<WorkerBirthPort["drainEvents"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { kind: "worker-birth", worker_id: "w3529", detail: null },
        {
          kind: "worker-death",
          worker_id: "w3529",
          detail: "session-error: could not find freshly minted issue #3529",
        },
      ]);
    const port: WorkerBirthPort = {
      socketPath,
      reach: async () => undefined,
      start: async () => {
        throw transportFailure;
      },
      drainEvents,
    };

    const birth = requestWorkerBirth(".", ["--issues", "3529", "--once"], {
      port,
      entry: [process.execPath],
    });

    await expect(birth).rejects.toThrow(/Worker w3529 was granted and then refused at boot/);
    await expect(birth).rejects.toThrow(/could not find freshly minted issue #3529/);
    await expect(birth).rejects.not.toThrow(/did not answer/);
    await expect(birth).rejects.not.toThrow(/red-skills-redskilled stop/);
    expect(drainEvents).toHaveBeenCalledTimes(2);
  });
});
