import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  brainAct,
  BrainActError,
  resolveChannelBridgeProcess,
  type ChannelBridgeConnector,
} from "@reddb-io/brain-store/brain-act.js";
import { McpStdioChannelBridge } from "@reddb-io/brain-store/channel-bridge.js";
import type {
  ChannelBridge,
  ChannelBridgeChannelsResult,
  ChannelBridgePollResult,
  ChannelBridgeSendResult,
} from "@reddb-io/brain-store/channel-bridge.js";

const pkgRoot = resolve(__dirname, "..");
const tsx = join(pkgRoot, "node_modules", ".bin", "tsx");
const fakeBridgeEntry = join(pkgRoot, "tests", "fixtures", "fake-channel-bridge.ts");
const TIMEOUT = 20_000;

const bridges: ChannelBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close().catch(() => {})));
});

describe("brainAct (unit, injected bridge)", () => {
  test("sends through the bridge send() path and returns the message id", async () => {
    const calls: Array<{ target: string; message: string }> = [];
    const bridge = makeFakeBridge({
      send: async (target, message) => {
        calls.push({ target, message });
        return { ok: true, target, messageId: "msg-9", raw: { ok: true, message_id: "msg-9" } };
      },
    });
    const result = await brainAct(
      { target: "slack:#engineering", message: "Ship it" },
      { connect: connectorFor(bridge) },
    );
    expect(result).toEqual({
      ok: true,
      target: "slack:#engineering",
      messageId: "msg-9",
      raw: { ok: true, message_id: "msg-9" },
    });
    expect(calls).toEqual([{ target: "slack:#engineering", message: "Ship it" }]);
    expect(bridge.closed).toBe(true);
  });

  test("trims the target before sending", async () => {
    let sentTarget = "";
    const bridge = makeFakeBridge({
      send: async (target) => {
        sentTarget = target;
        return { ok: true, target, raw: {} };
      },
    });
    await brainAct({ target: "  slack:#ops  ", message: "hi" }, { connect: connectorFor(bridge) });
    expect(sentTarget).toBe("slack:#ops");
  });

  test("rejects an empty target without touching the bridge", async () => {
    let connected = false;
    const connect: ChannelBridgeConnector = async () => {
      connected = true;
      return makeFakeBridge();
    };
    await expect(brainAct({ target: "   ", message: "hi" }, { connect })).rejects.toBeInstanceOf(BrainActError);
    await expect(brainAct({ target: "   ", message: "hi" }, { connect })).rejects.toThrow(/non-empty channel target/);
    expect(connected).toBe(false);
  });

  test("rejects an empty message without touching the bridge", async () => {
    let connected = false;
    const connect: ChannelBridgeConnector = async () => {
      connected = true;
      return makeFakeBridge();
    };
    await expect(brainAct({ target: "slack:#ops", message: "  " }, { connect })).rejects.toThrow(
      /non-empty message/,
    );
    expect(connected).toBe(false);
  });

  test("surfaces a bridge-reported failure (missing token / bad target) as a brain error", async () => {
    const bridge = makeFakeBridge({
      send: async (target) => ({ ok: false, target, raw: { ok: false, error: "no channel token for target" } }),
    });
    await expect(
      brainAct({ target: "slack:#nope", message: "hi" }, { connect: connectorFor(bridge) }),
    ).rejects.toThrow(/could not send to "slack:#nope": no channel token for target/);
    expect(bridge.closed).toBe(true);
  });

  test("falls back to a generic reason when the bridge gives no error detail", async () => {
    const bridge = makeFakeBridge({
      send: async (target) => ({ ok: false, target, raw: {} }),
    });
    await expect(
      brainAct({ target: "slack:#nope", message: "hi" }, { connect: connectorFor(bridge) }),
    ).rejects.toThrow(/reported a failed send/);
  });

  test("wraps a send() throw and still closes the bridge", async () => {
    const bridge = makeFakeBridge({
      send: async () => {
        throw new Error("socket hang up");
      },
    });
    await expect(
      brainAct({ target: "slack:#ops", message: "hi" }, { connect: connectorFor(bridge) }),
    ).rejects.toThrow(/could not send to "slack:#ops": socket hang up/);
    expect(bridge.closed).toBe(true);
  });

  test("wraps a bridge connection failure as a brain error", async () => {
    const connect: ChannelBridgeConnector = async () => {
      throw new Error("hermes: command not found");
    };
    await expect(brainAct({ target: "slack:#ops", message: "hi" }, { connect })).rejects.toThrow(
      /could not reach the channel bridge: hermes: command not found/,
    );
  });
});

describe("resolveChannelBridgeProcess", () => {
  test("defaults to no overrides (connect applies hermes mcp serve)", () => {
    expect(resolveChannelBridgeProcess({})).toEqual({ command: undefined, args: undefined });
  });

  test("honors env overrides for the bridge command and args", () => {
    expect(
      resolveChannelBridgeProcess({
        RED_BRAIN_HERMES_COMMAND: "my-hermes",
        RED_BRAIN_HERMES_ARGS: "mcp serve --outbound",
      }),
    ).toEqual({ command: "my-hermes", args: ["mcp", "serve", "--outbound"] });
  });
});

describe("brainAct (integration, standalone bridge — no gateway)", () => {
  test(
    "sends to a channel with channel tokens only and reports the message id",
    async () => {
      const result = await brainAct(
        { target: "slack:#engineering", message: "release train is green" },
        { connect: connectRealBridge },
      );
      expect(result).toMatchObject({ ok: true, target: "slack:#engineering", messageId: "msg-1" });
    },
    TIMEOUT,
  );

  test(
    "surfaces a bad target as a brain-scoped error",
    async () => {
      await expect(
        brainAct({ target: "bad:#unknown", message: "hi" }, { connect: connectRealBridge }),
      ).rejects.toThrow(/could not send to "bad:#unknown": no channel token for target/);
    },
    TIMEOUT,
  );
});

const connectRealBridge: ChannelBridgeConnector = async () => {
  const bridge = await McpStdioChannelBridge.connect({
    command: tsx,
    args: [fakeBridgeEntry],
    cwd: pkgRoot,
    env: safeProcessEnv(),
  });
  bridges.push(bridge);
  return bridge;
};

interface FakeBridge extends ChannelBridge {
  closed: boolean;
}

function makeFakeBridge(overrides: Partial<ChannelBridge> = {}): FakeBridge {
  const bridge: FakeBridge = {
    closed: false,
    poll: overrides.poll ?? (async (): Promise<ChannelBridgePollResult> => ({ events: [], raw: {} })),
    send:
      overrides.send ??
      (async (target: string): Promise<ChannelBridgeSendResult> => ({ ok: true, target, raw: {} })),
    channels:
      overrides.channels ?? (async (): Promise<ChannelBridgeChannelsResult> => ({ channels: [], raw: {} })),
    close:
      overrides.close ??
      (async () => {
        bridge.closed = true;
      }),
  };
  return bridge;
}

function connectorFor(bridge: ChannelBridge): ChannelBridgeConnector {
  return async () => bridge;
}

function safeProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
