import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeInvitation, encodeInvitationUri, encryptLinkPayload } from "@reddb-io/red-skills-link-protocol/crypto";
import { runRedskilledLinkHost } from "../src/host.js";
import {
  createRedskilledMobileLinkClient,
  pairRedskilledHost,
  type LinkWebSocketConstructor,
} from "@reddb-io/red-skills-link-protocol/mobile-client";
import { startRedskilledRelay, type RedskilledRelay } from "../src/relay.js";
import { createRedskilledLinkStateStore } from "../src/state.js";

const roots: string[] = [];
const relays: RedskilledRelay[] = [];
const controllers: AbortController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const relay of relays.splice(0)) await relay.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("app <> relay <> Host <> redskilled", () => {
  it("pairs once and projects only state, Ticket dispatch and Worker stop", async () => {
    const relay = await startRedskilledRelay();
    relays.push(relay);
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-e2e-"));
    roots.push(root);
    const state = createRedskilledLinkStateStore({
      path: join(root, "state.toon"),
      relayUrl: `ws://127.0.0.1:${relay.port}`,
      hostName: "Test Host",
    });
    const invitation = await state.createInvitation();
    const operator = {
      state: vi.fn(async () => ({ version: 1 as const, daemon_version: "4.2.0", workers: [] })),
      dispatch: vi.fn(async () => ({
        version: 1 as const,
        repository: "reddb-io/red-skills",
        ticket: 42,
        worker_id: "W42",
      })),
      stop: vi.fn(async () => ({ version: 1 as const, worker_id: "W42", applied: true, detail: "stopped" })),
    };
    const controller = new AbortController();
    controllers.push(controller);
    const host = runRedskilledLinkHost({ state, operator }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const paired = await pairRedskilledHost(
      encodeInvitation(invitation),
      "Android",
      WebSocket as unknown as LinkWebSocketConstructor,
    );
    const app = createRedskilledMobileLinkClient(
      paired,
      WebSocket as unknown as LinkWebSocketConstructor,
    );
    await expect(app.state()).resolves.toEqual({ version: 1, daemon_version: "4.2.0", workers: [] });
    await expect(app.dispatch("https://github.com/reddb-io/red-skills/issues/42")).resolves.toEqual({
      version: 1,
      repository: "reddb-io/red-skills",
      ticket: 42,
      worker_id: "W42",
    });
    await expect(app.stop("W42")).resolves.toEqual({
      version: 1,
      worker_id: "W42",
      applied: true,
      detail: "stopped",
    });
    expect(operator.dispatch).toHaveBeenCalledWith("https://github.com/reddb-io/red-skills/issues/42");
    expect(operator.stop).toHaveBeenCalledWith("W42");

    await expect(pairRedskilledHost(
      encodeInvitation(invitation),
      "Second Android",
      WebSocket as unknown as LinkWebSocketConstructor,
    )).rejects.toThrow("already used");
    controller.abort();
    await host;
  });

  it("keeps the Issue URL out of the relay-visible envelope", () => {
    const issueUrl = "https://github.com/reddb-io/private/issues/9";
    const encrypted = encryptLinkPayload({
      version: 1,
      request_id: "r1",
      operation: "ticket_dispatch",
      params: { issue_url: issueUrl },
    }, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(JSON.stringify(encrypted)).not.toContain(issueUrl);
    expect(JSON.stringify(encrypted)).not.toContain("ticket_dispatch");
  });

  it("pairs from the redskilled:// URI carried by the QR", async () => {
    const relay = await startRedskilledRelay();
    relays.push(relay);
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-uri-"));
    roots.push(root);
    const state = createRedskilledLinkStateStore({
      path: join(root, "state.toon"), relayUrl: `ws://127.0.0.1:${relay.port}`, hostName: "URI Host",
    });
    const controller = new AbortController();
    controllers.push(controller);
    const host = runRedskilledLinkHost({
      state,
      operator: {
        state: async () => ({ version: 1, daemon_version: "test", workers: [] }),
        dispatch: async () => { throw new Error("not reached"); },
        stop: async () => { throw new Error("not reached"); },
      },
    }, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(pairRedskilledHost(
      encodeInvitationUri(await state.createInvitation()),
      "Android",
      WebSocket as unknown as LinkWebSocketConstructor,
    )).resolves.toMatchObject({ host_name: "URI Host" });
    controller.abort();
    await host;
  });
});
