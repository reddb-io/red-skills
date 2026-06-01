import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 90_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-skill-recommend-"));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--skill-telemetry", "--root", root, "--yes"]);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

describe("memory recommend skills CLI", () => {
  test(
    "returns ranked RedSkills suggestions for a task",
    async () => {
      const root = await initRoot();
      const event = {
        event_type: "result",
        event_id: "evt-tdd",
        timestamp: "2026-05-22T16:00:00.000Z",
        session_id: "session-1",
        turn_id: "turn-1",
        name: "dev:tdd",
        source_kind: "plugin",
        path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
        runner: "codex",
        result: { status: "succeeded", duration_ms: 1200 },
      };
      const ingest = runMemory(["event", "skill", "--root", root], JSON.stringify(event));
      expect(ingest.status, ingest.stderr).toBe(0);

      const result = runMemory([
        "recommend",
        "skills",
        "use TDD for a regression fix",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        recommendations: Array<{
          name: string;
          reasons: string[];
          citations: Array<{ kind: string; urn: string }>;
        }>;
      };
      expect(body.status).toBe("ok");
      expect(body.recommendations[0].name).toBe("dev:tdd");
      expect(body.recommendations[0].reasons.join(" ")).toContain("task text matched");
      expect(body.recommendations[0].citations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "telemetry",
            urn: "skill-telemetry:plugin:dev:tdd",
          }),
        ]),
      );
    },
    TIMEOUT,
  );
});
