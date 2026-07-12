#!/usr/bin/env node
import { createInterface } from "node:readline";
import { resolveRspConfig } from "./config.js";
import { ResidentRspElisionStore, resolveResidentPaths } from "./resident-client.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export async function runRspMcpServer(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
      const result = await handle(request);
      write({ jsonrpc: "2.0", id: request.id ?? null, result });
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id: typeof requestOrNull(line)?.id === "undefined" ? null : requestOrNull(line)?.id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

async function handle(request: JsonRpcRequest): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "rsp", version: "0.1.0" },
    };
  }
  if (request.method === "tools/list") {
    return {
      tools: [
        {
          name: "rsp_stats",
          description: "Read resident rsp elision store stats.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "rsp_show",
          description: "Read an rsp elision handle through the resident server.",
          inputSchema: {
            type: "object",
            properties: { handle: { type: "string" } },
            required: ["handle"],
          },
        },
      ],
    };
  }
  if (request.method === "tools/call") {
    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const store = residentStore();
    if (params?.name === "rsp_stats") {
      return { content: [{ type: "text", text: JSON.stringify(await store.stats()) }] };
    }
    if (params?.name === "rsp_show") {
      const handle = String(params.arguments?.handle ?? "");
      const record = await store.get(handle);
      if (!record) return { content: [{ type: "text", text: "not found" }], isError: true };
      if ("status" in record) return { content: [{ type: "text", text: JSON.stringify(record) }], isError: true };
      return { content: [{ type: "text", text: record.original.toString("utf8") }] };
    }
  }
  return {};
}

function residentStore(): ResidentRspElisionStore {
  const config = resolveRspConfig(process.cwd(), process.env);
  return new ResidentRspElisionStore(resolveResidentPaths(process.cwd()), {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    byteBudget: config.byteBudget,
  });
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requestOrNull(line: string): JsonRpcRequest | null {
  try {
    return JSON.parse(line) as JsonRpcRequest;
  } catch {
    return null;
  }
}
