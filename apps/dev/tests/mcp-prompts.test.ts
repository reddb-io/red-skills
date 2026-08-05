import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCastleMcpServer } from "../src/mcp-server.js";

const THIN_PROMPT_MAX_CHARS = 160;
const PROMPT_NAMES = ["drain", "diagnose", "configure", "stop"];

describe("castle MCP intent prompts", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((shutdown) => shutdown()));
  });

  it("lists four thin doors that delegate only to help", async () => {
    const server = createCastleMcpServer();
    const client = new Client({ name: "castle-prompt-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(() => client.close(), () => server.close());

    const listed = await client.listPrompts();
    expect(listed.prompts.map(({ name }) => name)).toEqual(PROMPT_NAMES);

    const toolNames = (await client.listTools()).tools
      .map(({ name }) => name)
      .filter((name) => name !== "help");

    for (const name of PROMPT_NAMES) {
      const expanded = await client.getPrompt({ name });
      expect(expanded.messages).toHaveLength(1);
      const content = expanded.messages[0]?.content;
      expect(content?.type).toBe("text");
      const body = content?.type === "text" ? content.text : "";
      expect(body.length).toBeLessThanOrEqual(THIN_PROMPT_MAX_CHARS);
      expect(body).toMatch(/\bhelp\b/);
      for (const toolName of toolNames) {
        expect(body).not.toMatch(new RegExp(`\\b${toolName}\\b`));
      }
    }
  });

  it.each([".claude-plugin/plugin.json", ".codex-plugin/plugin.json"])(
    "projects the castle prompts through the %s host manifest",
    async (manifestPath) => {
      const pluginRoot = resolve(import.meta.dirname, "../../../plugins/dev");
      const manifest = JSON.parse(
        await readFile(resolve(pluginRoot, manifestPath), "utf8"),
      ) as { mcpServers?: string };
      const mcp = JSON.parse(
        await readFile(resolve(pluginRoot, manifest.mcpServers ?? ""), "utf8"),
      ) as { mcpServers?: Record<string, unknown> };

      expect(manifest.mcpServers).toBe("./.mcp.json");
      expect(mcp.mcpServers).toHaveProperty("castle");
      expect(PROMPT_NAMES.map((name) => `castle:${name}`)).toEqual([
        "castle:drain",
        "castle:diagnose",
        "castle:configure",
        "castle:stop",
      ]);
    },
  );
});
