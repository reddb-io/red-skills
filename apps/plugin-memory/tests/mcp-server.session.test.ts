import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  cleanupMcpServerTest,
  connect,
  roots,
  seedStore,
  TIMEOUT,
  type ToolResult,
} from "./mcp-server-test-helpers.js";

afterEach(cleanupMcpServerTest);

describe("MCP server over stdio", () => {
  test(
    "tier-aware verbs drive session / working-memory / promotion",
    async () => {
      const uri = await seedStore();
      const root = await mkdtemp(join(tmpdir(), "memory-mcp-session-"));
      roots.push(root);
      const client = await connect(uri, { MEMORY_ROOT: root });

      // 1. working.get without a session errors with a clear instruction.
      const missingSession = (await client.callTool({
        name: "memory_working_get",
        arguments: {},
      })) as ToolResult;
      expect(missingSession.isError).toBe(true);
      expect(missingSession.content[0]?.text).toContain("memory_session_start");

      // 2. session.start mints + writes the id; subsequent reads see it.
      const startRes = (await client.callTool({
        name: "memory_session_start",
        arguments: {},
      })) as ToolResult;
      const startStructured = startRes.structuredContent as { session_id?: string };
      const sessionId = startStructured?.session_id;
      expect(typeof sessionId).toBe("string");
      expect(sessionId).toMatch(/[0-9a-f-]{36}/);

      // 3. working.set appends an event and working.get returns it.
      const appendRes = (await client.callTool({
        name: "memory_working_set",
        arguments: {
          type: "decision_candidate",
          value: "use postgres advisory locks for the rotation worker",
        },
      })) as ToolResult;
      expect(appendRes.structuredContent).toMatchObject({
        session_id: sessionId,
        sequence: 1,
        type: "decision_candidate",
      });

      const getRes = (await client.callTool({
        name: "memory_working_get",
        arguments: {},
      })) as ToolResult;
      const got = decode(getRes.content[0]?.text ?? "{}") as {
        events: Array<{ type: string; value: string; sequence: number }>;
      };
      expect(got.events).toHaveLength(1);
      expect(got.events[0].type).toBe("decision_candidate");
      expect(got.events[0].sequence).toBe(1);
      expect(getRes.structuredContent?.count).toBe(1);

      // 4. promote runs the engine: the decision_candidate becomes an L3 node.
      const promoteRes = (await client.callTool({
        name: "memory_promote",
        arguments: {},
      })) as ToolResult;
      const report = decode(promoteRes.content[0]?.text ?? "{}") as {
        session_id: string;
        promoted: number;
        reinforced: number;
        skipped: number;
        promoted_rids: number[];
      };
      expect(report.session_id).toBe(sessionId);
      expect(report.promoted).toBe(1);
      expect(report.promoted_rids).toHaveLength(1);
      expect(promoteRes.structuredContent).toMatchObject({
        session_id: sessionId,
        promoted: 1,
      });

      // 5. session.end drops the file; tier-aware reads error again.
      const endRes = (await client.callTool({
        name: "memory_session_end",
        arguments: {},
      })) as ToolResult;
      expect(endRes.structuredContent).toMatchObject({ ok: true });

      const missingSetSession = (await client.callTool({
        name: "memory_working_set",
        arguments: { type: "x", value: "y" },
      })) as ToolResult;
      expect(missingSetSession.isError).toBe(true);
      expect(missingSetSession.content[0]?.text).toContain("memory_session_start");

      // 6. The read-only surface still works after the lifecycle dance.
      const statsRes = (await client.callTool({
        name: "memory_stats",
        arguments: {},
      })) as ToolResult;
      expect(statsRes.structuredContent).toHaveProperty("nodes");
    },
    TIMEOUT,
  );
});
