#!/usr/bin/env node
import { createInterface } from "node:readline";
import { type JsonObject } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import { resolveRspConfig, type RspRuntimeConfig } from "./config.js";
import type { RspLossLevel } from "./elision-store.js";
import { normalizeOutput, renderGenericJsonLane } from "./normalize.js";
import { ResidentRspElisionStore, resolveResidentPaths } from "./resident-client.js";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export async function runRspMcpServer(): Promise<void> {
  const config = resolveRspConfig(process.cwd(), process.env);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
      const result = await handle(request, config);
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

async function handle(request: JsonRpcRequest, config: RspRuntimeConfig): Promise<unknown> {
  if (request.method === "initialize") {
    return {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "rsp", version: "0.1.0" },
    };
  }
  if (request.method === "tools/list") {
    if (!config.enabled) {
      return {
        tools: [
          {
            name: "rsp_status",
            description: "Explain whether rsp is enabled in this directory.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }
    return {
      tools: [
        {
          name: "rsp_status",
          description: "Explain whether rsp is enabled in this directory.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "rsp_stats",
          description: "Read resident rsp accounting stats.",
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
        {
          name: "rsp_compress",
          description: "Compress arbitrary text or JSON through rsp normalization, JSON selection, TOON rendering, and reversible elision.",
          inputSchema: {
            type: "object",
            properties: {
              payload: {
                description: "Text, JSON value, or JSON-serializable payload to compress.",
              },
              level: {
                type: "string",
                enum: ["brief", "terse"],
                description: "Compression level. Defaults to brief.",
              },
            },
            required: ["payload"],
          },
        },
      ],
    };
  }
  if (request.method === "tools/call") {
    const params = request.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (params?.name === "rsp_status") {
      return { content: [{ type: "text", text: renderStatus(config) }] };
    }
    if (!config.enabled) {
      return { content: [{ type: "text", text: renderStatus(config) }], isError: true };
    }
    const store = residentStore(config);
    if (params?.name === "rsp_stats") {
      return {
        content: [{
          type: "text",
          text: renderToolPayload({ tool: "rsp_stats", ...await store.accountingStats(config.telemetryByteBudget) } as JsonObject),
        }],
      };
    }
    if (params?.name === "rsp_show") {
      const handle = String(params.arguments?.handle ?? "");
      const record = await store.get(handle);
      if (!record) {
        return {
          content: [{ type: "text", text: renderToolPayload(showErrorPayload(handle, "not found")) }],
          isError: true,
        };
      }
      if ("status" in record) {
        return {
          content: [{
            type: "text",
            text: renderToolPayload({
              tool: "rsp_show",
              handle,
              found: false,
              category: "real-error",
              error: record.status,
              expired_at: record.expired_at,
              help: [record.command],
            } as JsonObject),
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text",
          text: renderToolPayload({
            tool: "rsp_show",
            handle,
            found: true,
            bytes: record.original.length,
            text: record.original.toString("utf8"),
          } as JsonObject),
        }],
      };
    }
    if (params?.name === "rsp_compress") {
      return { content: [{ type: "text", text: await compressPayloadForMcp(params.arguments, store) }] };
    }
  }
  return {};
}

function renderToolPayload(payload: JsonObject): string {
  return `${encodeSnapshotToon(payload)}\n`;
}

function showErrorPayload(handle: string, error: string): JsonObject {
  return {
    tool: "rsp_show",
    handle,
    found: false,
    category: "real-error",
    error,
    help: ["rsp show el:<id>"],
  };
}

async function compressPayloadForMcp(
  args: Record<string, unknown> | undefined,
  store: Pick<ResidentRspElisionStore, "mint">,
): Promise<string> {
  const input = payloadToText(args?.payload);
  const level = mcpCompressLevel(args?.level);
  const jsonLane = await renderGenericJsonLane(input, {
    level,
    command: "rsp mcp compress",
    store,
  });
  if (jsonLane.detected) return ensureTrailingNewline(jsonLane.output);

  const normalized = normalizeOutput(input);
  if (level === "brief" && Buffer.byteLength(normalized) <= 2 * 1024) {
    return renderToolPayload({
      tool: "rsp_compress",
      level,
      detected: "text",
      bytes: Buffer.byteLength(input),
      text: normalized,
    } as JsonObject);
  }

  const bytes = Buffer.from(input);
  const handle = await store.mint(bytes, {
    command: "rsp mcp compress",
    loss: { level, bytes_elided: bytes.length },
  });
  return renderTextSummary(normalized, bytes.length, handle, level);
}

function payloadToText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload == null) return "";
  return JSON.stringify(payload);
}

function mcpCompressLevel(value: unknown): Extract<RspLossLevel, "brief" | "terse"> {
  return value === "terse" ? "terse" : "brief";
}

function renderTextSummary(text: string, rawBytes: number, handle: string, level: "brief" | "terse"): string {
  const inlineBytes = level === "terse" ? 1024 : 2 * 1024;
  const bytes = Buffer.from(text);
  const half = Math.max(1, Math.floor(inlineBytes / 2));
  const head = truncateUtf8(bytes.subarray(0, half));
  const tail = truncateUtf8(bytes.subarray(Math.max(0, bytes.length - half)));
  return renderToolPayload({
    tool: "rsp_compress",
    level,
    detected: "text",
    bytes: rawBytes,
    lines: countLines(bytes),
    head,
    tail: tail && tail !== head ? tail : null,
    handle,
    help: [`rsp show ${handle}`],
  } as JsonObject);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function truncateUtf8(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/�$/g, "");
}

function countLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) lines++;
  }
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

function residentStore(config: RspRuntimeConfig): ResidentRspElisionStore {
  return new ResidentRspElisionStore(resolveResidentPaths(process.cwd()), {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
  });
}

function renderStatus(config: RspRuntimeConfig): string {
  return renderToolPayload({
    tool: "rsp_status",
    enabled: config.enabled,
    status: config.enabled ? "enabled" : "disabled",
    message: config.enabled ? "rsp is enabled in this directory" : "rsp is not enabled in this directory",
    help: config.enabled ? [] : ["/red-setup"],
  } as JsonObject);
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
