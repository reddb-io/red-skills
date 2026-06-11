#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  "conversations_list",
  "conversation_get",
  "messages_read",
  "attachments_fetch",
  "events_poll",
  "events_wait",
  "messages_send",
  "channels_list",
  "permissions_list_open",
  "permissions_respond",
] as const;

const server = new Server(
  { name: "fake-hermes-channel-bridge", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
    .filter((name) => name !== process.env.FAKE_BRIDGE_OMIT_TOOL)
    .map((name) => ({
      name,
      description: `Fake bridge tool ${name}`,
      inputSchema: { type: "object", additionalProperties: true },
    })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await recordCall(req.params.name, req.params.arguments ?? {});
  switch (req.params.name) {
    case "events_poll":
      return text({
        next_cursor: 42,
        events: [
          {
            id: "evt-1",
            cursor: 41,
            type: "message",
            platform: "slack",
            target: "slack:#engineering",
            session_key: "slack:engineering",
            timestamp: "2026-06-04T12:00:00.000Z",
            text: "release train is green",
          },
        ],
      });
    case "messages_send": {
      const target = req.params.arguments?.target;
      if (typeof target !== "string" || target === "" || target.startsWith("bad:")) {
        return text({ ok: false, error: "no channel token for target" });
      }
      return text({
        ok: true,
        target,
        message_id: "msg-1",
      });
    }
    case "channels_list":
      return text({
        channels: [
          {
            target: "slack:#engineering",
            platform: "slack",
            name: "#engineering",
          },
          {
            target: "discord:#ops",
            platform: "discord",
            name: "#ops",
          },
        ],
      });
    default:
      return text({ ok: true, tool: req.params.name });
  }
});

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

async function recordCall(name: string, args: unknown): Promise<void> {
  const logPath = process.env.FAKE_BRIDGE_CALL_LOG;
  if (!logPath) return;
  await appendFile(logPath, `${JSON.stringify({ name, args })}\n`, "utf8");
}

await server.connect(new StdioServerTransport());
