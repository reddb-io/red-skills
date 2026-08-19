import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, test } from "vitest";
import {
  HERMES_CHANNEL_BRIDGE_TOOLS,
  McpStdioChannelBridge,
  type ChannelBridge,
} from "@reddb-io/brain-store/channel-bridge.js";

const TIMEOUT = 20_000;
const pkgRoot = resolve(__dirname, "..");
const tsx = join(pkgRoot, "node_modules", ".bin", "tsx");
const fakeBridgeEntry = join(pkgRoot, "tests", "fixtures", "fake-channel-bridge.ts");
const brainServerEntry = join(pkgRoot, "src", "mcp-server.ts");

const roots: string[] = [];
const bridges: ChannelBridge[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close().catch(() => {})));
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ChannelBridge MCP-stdio adapter", () => {
  test(
    "normalizes poll, send, and channels against a fake Hermes bridge",
    async () => {
      const root = await tempRoot();
      const callLog = join(root, "calls.jsonl");
      const bridge = await connectBridge({ FAKE_BRIDGE_CALL_LOG: callLog });
      bridges.push(bridge);

      const poll = await bridge.poll({ afterCursor: 5, sessionKey: "slack:engineering", limit: 1 });
      expect(poll).toMatchObject({
        nextCursor: 42,
        events: [
          {
            id: "evt-1",
            cursor: 41,
            type: "message",
            platform: "slack",
            target: "slack:#engineering",
            sessionKey: "slack:engineering",
            message: "release train is green",
          },
        ],
      });

      const send = await bridge.send("slack:#engineering", "Ship it");
      expect(send).toMatchObject({
        ok: true,
        target: "slack:#engineering",
        messageId: "msg-1",
      });

      const channels = await bridge.channels({ platform: "slack" });
      expect(channels.channels).toEqual([
        expect.objectContaining({ target: "slack:#engineering", platform: "slack", name: "#engineering" }),
        expect.objectContaining({ target: "discord:#ops", platform: "discord", name: "#ops" }),
      ]);

      const calls = await readCalls(callLog);
      expect(calls).toEqual([
        {
          name: "events_poll",
          args: { after_cursor: 5, session_key: "slack:engineering", limit: 1 },
        },
        {
          name: "messages_send",
          args: { target: "slack:#engineering", message: "Ship it" },
        },
        {
          name: "channels_list",
          args: { platform: "slack" },
        },
      ]);
    },
    TIMEOUT,
  );

  test(
    "rejects a bridge that does not advertise the full ten-tool contract",
    async () => {
      await expect(connectBridge({ FAKE_BRIDGE_OMIT_TOOL: "permissions_respond" })).rejects.toThrow(
        /missing tool\(s\): permissions_respond/,
      );
    },
    TIMEOUT,
  );

  test(
    "keeps raw Hermes tools off the agent-facing brain MCP surface",
    async () => {
      const client = await connectBrainMcp();
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      expect(names).toEqual([
        "brain_init",
        "brain_status",
        "brain_capture",
        "brain_search",
        "brain_think",
        "brain_get",
        "brain_link",
        "brain_backlinks",
        "brain_act",
        "brain_kpis",
      ]);
      for (const rawTool of HERMES_CHANNEL_BRIDGE_TOOLS) {
        expect(names).not.toContain(rawTool);
      }
    },
    TIMEOUT,
  );
});

async function connectBridge(env: Record<string, string> = {}): Promise<ChannelBridge> {
  return McpStdioChannelBridge.connect({
    command: tsx,
    args: [fakeBridgeEntry],
    cwd: pkgRoot,
    env: { ...safeProcessEnv(), ...env },
  });
}

async function connectBrainMcp(): Promise<Client> {
  const root = await tempRoot();
  const transport = new StdioClientTransport({
    command: tsx,
    args: [brainServerEntry],
    cwd: pkgRoot,
    env: { ...safeProcessEnv(), RED_BRAIN_ROOT: root },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-channel-bridge-"));
  roots.push(root);
  return root;
}

async function readCalls(path: string): Promise<Array<{ name: string; args: Record<string, unknown> }>> {
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

function safeProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}
