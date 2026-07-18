import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { decodeMemoryStateDocument } from "../src/toon-state.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-inbox-cli-"));
  roots.push(root);
  return root;
}

describe("memory inbox CLI", () => {
  test("quarantines a proposed durable fact with review context without writing a graph node", async () => {
    const root = await tempRoot();
    expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);

    const token = "sk-test_1234567890abcdefghijklmnopqrstuv";
    const quarantine = runMemory([
      "inbox",
      "quarantine",
      `The deployment token is ${token}.`,
      "--root",
      root,
      "--reason",
      "contains sensitive deployment credential",
      "--evidence",
      "extracted from Stop hook transcript",
      "--confidence",
      "AMBIGUOUS",
      "--source-kind",
      "hook",
      "--writer",
      "codex",
      "--hook",
      "Stop",
      "--json",
    ]);
    expect(quarantine.status, quarantine.stderr).toBe(0);
    const created = JSON.parse(quarantine.stdout) as {
      item: { id: string; status: string; privacyFindings: Array<{ kind: string }> };
    };
    expect(created.item.status).toBe("quarantined");
    expect(created.item.privacyFindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "openai-token" })]),
    );
    expect(JSON.stringify(created)).not.toContain(token);
    const toonPath = join(root, ".red/memory/inbox", `${created.item.id}.toon`);
    const toonRaw = await readFile(toonPath, "utf8");
    expect(toonRaw.trimStart().startsWith("{")).toBe(false);
    expect(decodeMemoryStateDocument(toonRaw)).toMatchObject({ id: created.item.id, status: "quarantined" });
    await expect(readFile(join(root, ".red/memory/inbox", `${created.item.id}.json`), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    const inspect = runMemory(["inbox", "inspect", created.item.id, "--root", root]);
    expect(inspect.status, inspect.stderr).toBe(0);
    expect(inspect.stdout).toContain(`memory inbox: ${created.item.id}`);
    expect(inspect.stdout).toContain("status: quarantined");
    expect(inspect.stdout).toContain("reason: contains sensitive deployment credential");
    expect(inspect.stdout).toContain("evidence: extracted from Stop hook transcript");
    expect(inspect.stdout).toContain("privacy: openai-token");
    expect(inspect.stdout).toContain("provenance: hook writer=codex hook=Stop confidence=AMBIGUOUS");
    expect(inspect.stdout).not.toContain(token);

    await rm(toonPath);
    await writeFile(join(root, ".red/memory/inbox", `${created.item.id}.json`), `${JSON.stringify(created.item, null, 2)}\n`);
    const legacyInspect = runMemory(["inbox", "inspect", created.item.id, "--root", root]);
    expect(legacyInspect.status, legacyInspect.stderr).toBe(0);
    expect(legacyInspect.stdout).toContain("status: quarantined");

    const stats = runMemory(["stats", "--root", root]);
    expect(stats.status, stats.stderr).toBe(0);
    expect(stats.stdout).toContain("memory: 0 node(s), 0 edge(s)");
  }, TIMEOUT);

  test("lists, approves, rejects, and promotes inbox items only after approval", async () => {
    const root = await tempRoot();
    expect(runMemory(["init", "--mode", "graph", "--root", root, "--yes"]).status).toBe(0);

    const approvedCandidate = runMemory([
      "inbox",
      "quarantine",
      "Memory inbox promotion requires explicit approval before durable storage.",
      "--root",
      root,
      "--reason",
      "needs human review before becoming durable",
      "--evidence",
      "issue 132 acceptance criteria",
      "--json",
    ]);
    expect(approvedCandidate.status, approvedCandidate.stderr).toBe(0);
    const approvedId = (JSON.parse(approvedCandidate.stdout) as { item: { id: string } }).item.id;

    const rejectedCandidate = runMemory([
      "inbox",
      "quarantine",
      "Temporary WIP: tests are running.",
      "--root",
      root,
      "--reason",
      "temporary progress is not durable memory",
      "--evidence",
      "agent run log",
      "--json",
    ]);
    expect(rejectedCandidate.status, rejectedCandidate.stderr).toBe(0);
    const rejectedId = (JSON.parse(rejectedCandidate.stdout) as { item: { id: string } }).item.id;

    const blockedPromote = runMemory(["inbox", "promote", approvedId, "--root", root, "--yes"]);
    expect(blockedPromote.status).not.toBe(0);
    expect(blockedPromote.stderr).toContain("must be approved before promotion");

    const approve = runMemory(["inbox", "approve", approvedId, "--root", root, "--yes"]);
    expect(approve.status, approve.stderr).toBe(0);
    expect(approve.stdout).toContain(`memory inbox: approved ${approvedId}`);

    const stillEmpty = runMemory(["stats", "--root", root]);
    expect(stillEmpty.status, stillEmpty.stderr).toBe(0);
    expect(stillEmpty.stdout).toContain("memory: 0 node(s), 0 edge(s)");

    const reject = runMemory([
      "inbox",
      "reject",
      rejectedId,
      "--root",
      root,
      "--reason",
      "not durable",
      "--yes",
    ]);
    expect(reject.status, reject.stderr).toBe(0);
    expect(reject.stdout).toContain(`memory inbox: rejected ${rejectedId}`);

    const list = runMemory(["inbox", "list", "--root", root]);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain(`${approvedId} [approved]`);
    expect(list.stdout).toContain(`${rejectedId} [rejected]`);

    const promote = runMemory(["inbox", "promote", approvedId, "--root", root, "--yes", "--json"]);
    expect(promote.status, promote.stderr).toBe(0);
    const promoted = JSON.parse(promote.stdout) as { item: { status: string; promotedRid: number } };
    expect(promoted.item.status).toBe("promoted");
    expect(promoted.item.promotedRid).toBeGreaterThan(0);

    const finalStats = runMemory(["stats", "--root", root]);
    expect(finalStats.status, finalStats.stderr).toBe(0);
    expect(finalStats.stdout).toContain("memory: 1 node(s), 0 edge(s)");
  }, TIMEOUT);
});
