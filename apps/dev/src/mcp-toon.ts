import { encode, type JsonValue } from "@reddb-io/toon";

/**
 * Encode one structured redskilled MCP payload as canonical compact TOON.
 *
 * MCP tool values are JSON-shaped but typed as `unknown` at the transport
 * boundary. The JSON round-trip preserves the existing wire contract while the
 * encoder owns quoting, indentation, and nested tabular compaction.
 */
export function encodeRedskilledMcpToon(value: unknown): string {
  return encode(JSON.parse(JSON.stringify(value ?? null)) as JsonValue);
}
