import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseRedskilledBrainCall, REDSKILLED_BRAIN_TOOLS } from "@reddb-io/protocol-acp";
import type { BrainStoreLike } from "@reddb-io/brain-store/store.js";
import type { ResolvedBrainConfig } from "@reddb-io/brain-store/config.js";

import { brainMethodDomain } from "../src/acp-brain.js";
import { createHostBrainStore } from "../src/brain-store.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

/** A stubbed HOME, so the resolution is exercised rather than mocked away. */
async function stubHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "redskilled-brain-home-"));
  homes.push(home);
  return home;
}

interface RecordedStore extends BrainStoreLike {
  readonly captured: unknown[];
  readonly closes: () => number;
}

function recordingStore(): RecordedStore {
  const captured: unknown[] = [];
  let closes = 0;
  const unsupported = () => {
    throw new Error("not reached by these tests");
  };
  return {
    captured,
    closes: () => closes,
    async close() {
      closes += 1;
    },
    async status() {
      return { artifacts: captured.length };
    },
    async capture(input) {
      captured.push(input);
      return { rid: captured.length, label: input.title, kind: "note", properties: {} } as never;
    },
    async search(query, limit) {
      return [{ query, limit }] as never;
    },
    think: unsupported as never,
    getArtifact: unsupported as never,
    listArtifacts: unsupported as never,
    link: unsupported as never,
    backlinks: unsupported as never,
    listConnections: unsupported as never,
    eventKpis: unsupported as never,
    appendOutcomeEvent: unsupported as never,
    replayOutcomeEvents: unsupported as never,
    loadModelTierBanditDocument: unsupported as never,
    saveModelTierBanditDocument: unsupported as never,
    refreshModelTierBanditDocument: unsupported as never,
  };
}

// ADR 0152 / issue #4026: the store is the USER's, held once per host by the
// daemon. Both halves are asserted here — WHERE it resolves, and that a second
// session gets the handle the first one opened rather than one of its own.
describe("the host brain store the daemon holds", () => {
  it("resolves every call against ~/.red/brain under a stubbed HOME", async () => {
    const home = await stubHome();
    const opened: ResolvedBrainConfig[] = [];
    const holder = createHostBrainStore({
      env: { HOME: home },
      open: async (config) => {
        opened.push(config);
        return recordingStore();
      },
    });

    const answer = await holder.call({ tool: "brain_status", arguments: {} });

    expect(answer.root).toBe(home);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.connectionString).toBe(`file://${join(home, ".red", "brain", "brain.rdb")}`);
    expect(opened[0]!.configPath).toBe(join(home, ".red", "brain", "config.yaml"));
    await holder.close();
  });

  it("gives two sessions one store handle, opened once", async () => {
    const home = await stubHome();
    let opens = 0;
    const store = recordingStore();
    const holder = createHostBrainStore({
      env: { HOME: home },
      open: async () => {
        opens += 1;
        return store;
      },
    });

    // Two connections, each composing its OWN domain — exactly what the control
    // plane does per socket — and both closing over the one holder.
    const sessionOne = brainMethodDomain({ store: holder });
    const sessionTwo = brainMethodDomain({ store: holder });
    const callOf = (domain: ReturnType<typeof brainMethodDomain>) => domain.bindings[0]!;

    await Promise.all([
      callOf(sessionOne).handle({
        params: parseRedskilledBrainCall({
          tool: "brain_capture",
          arguments: { title: "one", content: "from session one" },
        }),
        client: {},
      }),
      callOf(sessionTwo).handle({
        params: parseRedskilledBrainCall({
          tool: "brain_capture",
          arguments: { title: "two", content: "from session two" },
        }),
        client: {},
      }),
    ]);

    expect(opens, "a concurrent second session must not start a second open").toBe(1);
    expect(store.captured).toHaveLength(2);
    await holder.close();
    expect(store.closes()).toBe(1);
  });

  it("retries the open after a failure instead of poisoning the host", async () => {
    const home = await stubHome();
    let opens = 0;
    const holder = createHostBrainStore({
      env: { HOME: home },
      open: async () => {
        opens += 1;
        if (opens === 1) throw new Error("disk was busy");
        return recordingStore();
      },
    });

    await expect(holder.call({ tool: "brain_status", arguments: {} })).rejects.toThrow(/disk was busy/);
    await expect(holder.call({ tool: "brain_status", arguments: {} })).resolves.toMatchObject({
      root: home,
    });
    expect(opens).toBe(2);
    await holder.close();
  });

  it("serves brain_act from the daemon's bridge, never from the caller's process", async () => {
    const home = await stubHome();
    const sent: unknown[] = [];
    const holder = createHostBrainStore({
      env: { HOME: home },
      open: async () => recordingStore(),
      act: async (input) => {
        sent.push(input);
        return { ok: true, target: input.target };
      },
    });

    const answer = await holder.call({
      tool: "brain_act",
      arguments: { target: "slack:#ops", message: "shipped" },
    });

    expect(sent).toEqual([{ target: "slack:#ops", message: "shipped" }]);
    expect(answer.result).toMatchObject({ ok: true, target: "slack:#ops" });
    await holder.close();
  });

  it("refuses a caller that names anything but a tool and its arguments", () => {
    expect(() => parseRedskilledBrainCall({ tool: "brain_status", root: "/tmp/elsewhere" }))
      .toThrow(/store root is the daemon's/);
    expect(() => parseRedskilledBrainCall({ tool: "brain_delete_everything", arguments: {} }))
      .toThrow(/unknown brain tool/);
  });

  it("advertises the brain surface it binds", () => {
    const domain = brainMethodDomain({ store: createHostBrainStore({ env: {} }) });

    expect(domain.bindings.map((binding) => binding.method)).toEqual(["_redskills/brain_call"]);
    expect(domain.capability).toMatchObject({
      brain: { version: 1, tools: REDSKILLED_BRAIN_TOOLS },
    });
  });
});
