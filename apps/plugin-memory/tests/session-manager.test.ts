import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  current,
  end,
  ensure,
  sessionFile,
  start,
} from "../src/session-manager.js";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-session-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("SessionManager", () => {
  test("current() returns null when the file does not exist", async () => {
    const root = await tempRoot();
    expect(await current(root)).toBeNull();
  });

  test("start() mints a UUID, writes the file, returns the id", async () => {
    const root = await tempRoot();
    const id = await start(root);
    expect(id).toMatch(UUID_RE);
    expect(await readFile(sessionFile(root), "utf8")).toBe(`${id}\n`);
    expect(await current(root)).toBe(id);
  });

  test("start({id}) honours an explicit id over minting", async () => {
    const root = await tempRoot();
    const id = await start(root, { id: "session-explicit-123" });
    expect(id).toBe("session-explicit-123");
    expect(await current(root)).toBe("session-explicit-123");
  });

  test("start() creates the sessions directory if missing", async () => {
    const root = await tempRoot();
    // Sanity: directory does not exist beforehand.
    await expect(stat(dirname(sessionFile(root)))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await start(root);
    const st = await stat(dirname(sessionFile(root)));
    expect(st.isDirectory()).toBe(true);
  });

  test("start() overwrites an existing session", async () => {
    const root = await tempRoot();
    const first = await start(root);
    const second = await start(root);
    expect(second).not.toBe(first);
    expect(await current(root)).toBe(second);
  });

  test("end() drops the file and is idempotent", async () => {
    const root = await tempRoot();
    await start(root);
    await end(root);
    expect(await current(root)).toBeNull();
    await expect(end(root)).resolves.toBeUndefined();
  });

  test("ensure() returns existing id without minting a new one", async () => {
    const root = await tempRoot();
    const first = await start(root, { id: "pre-existing" });
    const resolved = await ensure(root);
    expect(resolved).toBe(first);
    expect(await readFile(sessionFile(root), "utf8")).toBe(`${first}\n`);
  });

  test("ensure() honours MEMORY_SESSION_ID env var when no file present", async () => {
    const root = await tempRoot();
    const id = await ensure(root, { env: { MEMORY_SESSION_ID: "from-env" } });
    expect(id).toBe("from-env");
    expect(await current(root)).toBe("from-env");
  });

  test("ensure() mints a fresh UUID when nothing else is provided", async () => {
    const root = await tempRoot();
    const id = await ensure(root, { env: {} });
    expect(id).toMatch(UUID_RE);
    expect(await current(root)).toBe(id);
  });

  test("current() tolerates a trailing newline and an empty file", async () => {
    const root = await tempRoot();
    await mkdir(dirname(sessionFile(root)), { recursive: true });
    await writeFile(sessionFile(root), "abc\n", "utf8");
    expect(await current(root)).toBe("abc");
    await writeFile(sessionFile(root), "", "utf8");
    expect(await current(root)).toBeNull();
  });
});
