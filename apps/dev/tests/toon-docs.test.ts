import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("TOONL operational docs", () => {
  it("documents tq, not jq, for RedSkills-owned TOONL lane reads", async () => {
    const docs = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/afk/docs/LIVENESS.md"),
      readRepoFile("plugins/dev/skills/engineering/afk/docs/OPERATIONS.md"),
      readRepoFile("plugins/dev/skills/engineering/afk/monitor.md"),
      readRepoFile("plugins/dev/skills/engineering/daily-review/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
    ]);
    const joined = docs.join("\n");

    expect(joined).toContain("tq -p toonl -o json -r .msg");
    expect(joined).toContain(".red/state/castle/history.toonl");
    expect(joined).toContain(".red/tmp/supervisors/default/supervisor.log.toonl");
    expect(joined).toContain("there is no jq fallback");
    expect(joined).not.toMatch(/afk-history\.jsonl/);
    const laneReaderLines = joined
      .split("\n")
      .filter((line) => /agent\.log|castle\/history|live transcript|TOONL lane/i.test(line));
    expect(laneReaderLines.join("\n")).not.toMatch(/\|\s*jq\b/);
  });

  it("keeps the documented tq examples valid against produced TOONL lane files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "red-skills-toon-docs-"));
    try {
      const agentLane = join(dir, "agent.log.toonl");
      const historyLane = join(dir, "afk-history.toonl");
      const supervisorFirehose = join(dir, "supervisor.log.toonl");
      await writeFile(
        agentLane,
        [
          "[]{ts,worker,type,msg,iteration,kind}:",
          '"2026-07-15T00:00:00Z",wDOCS,agent,hello,1,text',
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        historyLane,
        [
          "[]{ts,epoch,worker,issue,event,duration_s,runner,merge_sha,reason}:",
          '"2026-07-15T00:00:00Z",1786,wDOCS,1786,done,12,codex,abc123,null',
          "",
        ].join("\n"),
        "utf8",
      );
      await writeFile(
        supervisorFirehose,
        [
          "[]{ts,worker,type,msg,scope,runner,ready_for_agent,slots_busy,slots_free,slots_total,slots_parked,spawns_this_tick}:",
          '"2026-07-15T00:00:00Z",fleet,heartbeat,"fleet tick ready=4 busy=1 free=1 spawns=1",fleet,codex,4,1,1,2,0,1',
          "",
        ].join("\n"),
        "utf8",
      );

      const agent = await execFileAsync("tq", ["-p", "toonl", "-o", "json", "-r", ".msg", agentLane]);
      expect(agent.stdout.trim()).toBe("hello");

      const firehose = await execFileAsync("tq", ["-p", "toonl", "-o", "json", "-r", ".msg", supervisorFirehose]);
      expect(firehose.stdout.trim()).toBe("fleet tick ready=4 busy=1 free=1 spawns=1");

      const history = await execFileAsync("tq", [
        "-p",
        "toonl",
        "-o",
        "json",
        'select(.event == "done") | {issue: .issue, worker: .worker, runner: .runner}',
        historyLane,
      ]);
      expect(JSON.parse(history.stdout)).toEqual({ issue: 1786, worker: "wDOCS", runner: "codex" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
