import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { sessionFile } from "../src/session-manager.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-session-cli-"));
  roots.push(dir);
  return dir;
}

function runMemory(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
    env: { ...process.env, ...env },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("memory session show|start|end", () => {
  test(
    "show prints 'none' when no session minted yet",
    async () => {
      const root = await tempRoot();
      const r = runMemory(["session", "show", "--root", root]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("none");
    },
    TIMEOUT,
  );

  test(
    "start mints, show reflects it, end drops it",
    async () => {
      const root = await tempRoot();
      const s1 = runMemory(["session", "start", "--root", root, "--json"]);
      expect(s1.status).toBe(0);
      const { session_id } = JSON.parse(s1.stdout);
      expect(session_id).toMatch(UUID_RE);

      const file = sessionFile(root);
      expect((await readFile(file, "utf8")).trim()).toBe(session_id);

      const s2 = runMemory(["session", "show", "--root", root]);
      expect(s2.stdout.trim()).toBe(session_id);

      const s3 = runMemory(["session", "end", "--root", root]);
      expect(s3.status).toBe(0);
      await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });

      const s4 = runMemory(["session", "show", "--root", root]);
      expect(s4.stdout.trim()).toBe("none");
    },
    TIMEOUT,
  );

  test(
    "start --id honours an explicit id",
    async () => {
      const root = await tempRoot();
      const r = runMemory(["session", "start", "--root", root, "--id", "abc-123"]);
      expect(r.status).toBe(0);
      expect((await readFile(sessionFile(root), "utf8")).trim()).toBe("abc-123");
    },
    TIMEOUT,
  );

  test(
    "session needs a known action",
    async () => {
      const root = await tempRoot();
      const r = runMemory(["session", "bogus", "--root", root]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/session needs an action/);
    },
    TIMEOUT,
  );
});

describe("hook SessionStart mints into .red/memory/sessions/current", () => {
  test(
    "Claude SessionStart writes the runner-supplied session_id",
    async () => {
      const root = await tempRoot();
      const payload = JSON.stringify({ session_id: "claude-sess-42", cwd: root });
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "hook", "SessionStart", "--runner", "claude"],
        {
          cwd: PLUGIN_ROOT,
          encoding: "utf8",
          input: payload,
          timeout: TIMEOUT,
        },
      );
      expect(r.status).toBe(0);
      expect((await readFile(sessionFile(root), "utf8")).trim()).toBe("claude-sess-42");
    },
    TIMEOUT,
  );

  test(
    "first non-SessionStart hook call ensures a session (Codex fallback)",
    async () => {
      const root = await tempRoot();
      const payload = JSON.stringify({ cwd: root });
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "hook", "Stop", "--runner", "codex"],
        {
          cwd: PLUGIN_ROOT,
          encoding: "utf8",
          input: payload,
          timeout: TIMEOUT,
          env: { ...process.env, MEMORY_SESSION_ID: "from-env-codex" },
        },
      );
      expect(r.status).toBe(0);
      expect((await readFile(sessionFile(root), "utf8")).trim()).toBe("from-env-codex");
    },
    TIMEOUT,
  );
});
