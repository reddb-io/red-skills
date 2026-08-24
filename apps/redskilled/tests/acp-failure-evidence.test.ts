// The public ACP surface always answers its client — a refusal-shaped update,
// or a destroyed socket — and historically kept nothing on the daemon side.
// That is the exact "the daemon looks broken and emits no errors" dead end this
// suite closes: a failed turn or connection now leaves one durable record on
// the host event lane, without changing what the client is told.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { socketStream } from "@reddb-io/protocol-acp";
import { afterEach, describe, expect, it } from "vitest";

import {
  ACP_V2_DRAFT_REVISION,
  REDSKILLS_WIRE_MAJOR,
  startRedskillsAcpControlPlane,
} from "../src/acp-control-plane.js";
import {
  buildAcpFailureEvent,
  createRedskilledEventLane,
  type RecordAcpFailureInput,
} from "../src/event-lane.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("an ACP failure leaves evidence instead of vanishing", () => {
  it("buildAcpFailureEvent shapes a daemon-scoped record naming its surface", () => {
    const input: RecordAcpFailureInput = {
      ts: "2026-08-24T12:00:00.000Z",
      projectLabel: "reddb-io/red-skills",
      detail: "an ACP v2 turn ended as a refusal: the Worker died at birth",
      surface: "turn",
    };
    expect(buildAcpFailureEvent(input)).toMatchObject({
      kind: "acp-failure",
      event: "acp-failure",
      worker_id: "acp:turn",
      project_label: "reddb-io/red-skills",
      detail: input.detail,
      reason: "turn",
      pid: 0,
    });
  });

  it("recordAcpFailure round-trips through the lane's own reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-failure-lane-"));
    roots.push(root);
    const lane = createRedskilledEventLane(join(root, "lane.toonl"));
    await lane.recordAcpFailure({
      ts: "2026-08-24T12:00:00.000Z",
      projectLabel: "redskilled/acp",
      detail: "redskilled could not serve a public ACP connection: boom",
      surface: "connection",
    });
    const events = await lane.read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "acp-failure",
      worker_id: "acp:connection",
      project_label: "redskilled/acp",
      detail: "redskilled could not serve a public ACP connection: boom",
      reason: "connection",
    });
  });

  it("a v2 turn that dies records the same sentence its client only sees in _meta", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-failure-turn-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const failures: { projectLabel: string; detail: string; surface: string }[] = [];
    const control = await startRedskillsAcpControlPlane({
      paths,
      hostState: () => ({ workers: [], daemon_version: "9.9.9" }) as never,
      startWorker: () => { throw new Error("the Worker died at birth"); },
      recordAcpFailure: (failure) => failures.push(failure),
    });
    const refusals: string[] = [];
    try {
      const socket = connect(control.socketPath);
      await once(socket, "connect");
      const connection = acpV2.client({ name: "acp-failure-evidence" })
        .onNotification(acpV2.methods.client.session.update, ({ params }) => {
          const update = params.update;
          if (update.sessionUpdate === "state_update" && update.state === "idle") {
            refusals.push(typeof update.stopReason === "string" ? update.stopReason : "");
          }
        })
        .connect(socketStream(socket));
      await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "acp-failure-evidence", version: "1" },
        capabilities: {},
        _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR, acpDraftRevision: ACP_V2_DRAFT_REVISION } },
      });
      const session = await connection.agent.request(acpV2.methods.agent.session.new, {
        cwd: root,
        mcpServers: [],
      });
      await connection.agent.request(acpV2.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "do anything" }],
      });
      await waitFor(() => failures.length > 0, "the recorded turn failure");

      expect(failures).toEqual([{
        projectLabel: expect.any(String),
        detail: expect.stringContaining("the Worker died at birth"),
        surface: "turn",
      }]);
      // The client-facing answer is unchanged: the turn still ends as a refusal.
      await waitFor(() => refusals.length > 0, "the refusal-shaped idle update");
      expect(refusals).toEqual(["refusal"]);
      connection.close();
    } finally {
      await control.close();
    }
  }, 30_000);
});

async function waitFor(condition: () => boolean, subject: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${subject}`);
}
