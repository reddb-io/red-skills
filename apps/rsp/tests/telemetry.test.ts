import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect } from "@reddb-io/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTelemetryEvent,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  telemetrySpoolPath,
} from "../src/telemetry.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/config.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { runResidentServer } from "../src/resident-server.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-telemetry-"));
  roots.push(root);
  await mkdir(join(root, ".red", "tmp"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp telemetry spool", () => {
  it("appends JSONL without throwing when the target is unavailable", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "ok",
      command: "git status",
    });
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toContain('"id":"ok"');

    await writeFile(join(root, ".red", "tmp", "not-a-dir"), "x", "utf8");
    await expect(appendTelemetryEvent(join(root, "not-there"), {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "lost",
    })).resolves.toBeUndefined();
  });

  it("drains boot and idle telemetry into RedDB while skipping malformed lines", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "boot-event",
      command: "git status",
      bytes: 100,
    });
    await writeFile(telemetrySpoolPath(root), "not-json\n", { flag: "a" });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);

    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      id: "idle-event",
      reason: "resident unavailable",
      bytes: 100,
    });
    await server;

    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "boot-event")).resolves.toMatchObject({
      id: "boot-event",
      command: "git status",
    });
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_DEGRADATIONS_COLLECTION, "idle-event")).resolves.toMatchObject({
      id: "idle-event",
      reason: "resident unavailable",
    });
  }, 20_000);

  it("enforces telemetry ttl and byte budget without pruning elisions", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "expired",
      created_at: "2000-01-01T00:00:00.000Z",
      bytes: 10,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "oldest",
      created_at: "2099-01-01T00:00:00.000Z",
      bytes: 60,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "newest",
      created_at: "2099-01-02T00:00:00.000Z",
      bytes: 60,
    });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 1,
      telemetryByteBudget: 75,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);
    await server;

    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "expired")).resolves.toBeNull();
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "oldest")).resolves.toBeNull();
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "newest")).resolves.toMatchObject({
      id: "newest",
    });
  }, 20_000);

  it("drains a hand-written spool through the built bundle resident", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    await writeFile(telemetrySpoolPath(root), `${JSON.stringify({
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "bundle-event",
      command: "git log",
    })}\n`, "utf8");

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const child = execFile(process.execPath, [
      bundle,
      "server",
      "--socket",
      paths.socketPath,
      "--store-uri",
      storeUri,
      "--ttl-days",
      String(DEFAULT_RSP_TTL_DAYS),
      "--byte-budget",
      String(DEFAULT_RSP_BYTE_BUDGET),
      "--idle-ms",
      "100",
    ], { cwd: root });
    await waitForResident(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`bundle resident exited ${code}`)));
      child.once("error", reject);
    });

    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "bundle-event")).resolves.toMatchObject({
      id: "bundle-event",
      command: "git log",
    });
  }, 40_000);
});

async function readTelemetry(storeUri: string, collection: string, key: string): Promise<unknown> {
  const db = await connect(storeUri);
  try {
    const raw = await db.kv(collection).get(key);
    return typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  } finally {
    await db.close();
  }
}

async function waitForResident(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: `wait-${attempt++}`, op: "ping" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident did not start");
}

async function ensureRspBundle(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, "..");
  const repoRoot = resolve(appRoot, "..", "..");
  const bundle = join(repoRoot, "dist", "rsp.bundle.min.mjs");
  if (existsSync(bundle)) return bundle;
  await execFileAsync(process.execPath, [
    join(repoRoot, "scripts", "bundle-app.mjs"),
    "--entry",
    "src/cli.ts",
    "--outfile",
    "../../dist/rsp.bundle.min.mjs",
    "--asset",
    "rsp.bundle.min.mjs",
    "--minify",
    "--reddb-from-package",
  ], { cwd: appRoot });
  return bundle;
}
