#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CASTLE_RESIDENT_PROTOCOL_VERSION,
  resolveCastleResidentPaths,
  sendCastleResidentRequest,
} from "@reddb-io/red-castle/resident";

const root = resolve(process.argv[2] ?? process.cwd());
const proxy = resolve(root, "dist/redskilled-mcp.bundle.min.mjs");
const profiles = [1, 4, 8];
const results: unknown[] = [];

for (const sessions of profiles) {
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  try {
    await Promise.all(Array.from({ length: sessions }, async (_, index) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [proxy],
        cwd: root,
        stderr: "pipe",
      });
      const client = new Client({ name: `castle-diagnostic-${index}`, version: "1" });
      transports.push(transport);
      clients.push(client);
      await client.connect(transport);
      await client.listTools();
    }));

    const paths = resolveCastleResidentPaths(root);
    const status = await sendCastleResidentRequest(paths.socketPath, {
      id: `diagnostic-${sessions}`,
      op: "status",
      protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
    });
    if (!status.ok) throw new Error(`${status.error.code}: ${status.error.message}`);
    const proxyPids = transports.map((transport) => transport.pid).filter((pid): pid is number => pid !== null);
    const proxyRss = await Promise.all(proxyPids.map(readLinuxRssBytes));
    results.push({
      sessions,
      proxy_processes: proxyPids.length,
      proxy_rss_bytes: proxyRss,
      resident: status.value,
    });
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}

process.stdout.write(`${JSON.stringify({ schema: "red.castle.session_diagnostic.v1", profiles: results }, null, 2)}\n`);

async function readLinuxRssBytes(pid: number): Promise<number | null> {
  if (process.platform !== "linux") return null;
  try {
    const [, residentPages] = (await readFile(`/proc/${pid}/statm`, "utf8")).trim().split(/\s+/, 2);
    return Number(residentPages) * 4096;
  } catch {
    return null;
  }
}
