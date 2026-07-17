import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RSP_IDLE_MS,
  DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
  DEFAULT_RSP_TELEMETRY_BYTE_BUDGET,
  DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS,
  DEFAULT_RSP_TELEMETRY_DRAIN_TIMEOUT_MS,
  DEFAULT_RSP_TELEMETRY_TTL_DAYS,
  DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
  MIN_RSP_IDLE_MS,
  resolveRspConfig,
} from "../src/config.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/elision-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveRspConfig", () => {
  it("reads retention knobs from the top-level rsp block", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(
      join(root, ".red", "config.yaml"),
      "rsp:\n  ttlDays: 3\n  ephemeralTtlHours: 4\n  byteBudget: 42\n  telemetryTtlDays: 11\n  telemetryByteBudget: 100\n  telemetryDrainTimeoutMs: 456\n  idleMs: 10000\n  heavyGitByteThreshold: 99\n",
      "utf8",
    );

    expect(resolveRspConfig(join(root, "nested"), {}, undefined)).toEqual({
      enabled: false,
      proxyEnabled: false,
      storeUri: `file://${join(root, ".red", "state", "red-skills.rdb")}`,
      ttlDays: 3,
      ephemeralTtlHours: 4,
      byteBudget: 42,
      telemetryTtlDays: 11,
      telemetryByteBudget: 100,
      telemetryDrainIntervalMs: DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS,
      telemetryDrainTimeoutMs: 456,
      idleMs: 10_000,
      heavyGitByteThreshold: 99,
      measurementHoldoutShare: 0,
    });
  });

  it("defaults proxy routing ON when rsp is enabled and no proxy key is set", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    // One opt-in, not two: rsp.enabled carries proxy routing with it.
    expect(resolveRspConfig(root, {}, undefined)).toEqual({
      enabled: true,
      proxyEnabled: true,
      storeUri: `file://${join(root, ".red", "state", "red-skills.rdb")}`,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      ephemeralTtlHours: DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: DEFAULT_RSP_TELEMETRY_TTL_DAYS,
      telemetryByteBudget: DEFAULT_RSP_TELEMETRY_BYTE_BUDGET,
      telemetryDrainIntervalMs: DEFAULT_RSP_TELEMETRY_DRAIN_INTERVAL_MS,
      telemetryDrainTimeoutMs: DEFAULT_RSP_TELEMETRY_DRAIN_TIMEOUT_MS,
      idleMs: DEFAULT_RSP_IDLE_MS,
      heavyGitByteThreshold: DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
      measurementHoldoutShare: 0,
    });
  });

  it("keeps measurement holdout off by default and reads it additively", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  measurement:\n    holdoutShare: 0.05\n", "utf8");

    const config = resolveRspConfig(root, {}, undefined);

    expect(config.proxyEnabled).toBe(true);
    expect(config.measurementHoldoutShare).toBe(0.05);
    expect(resolveRspConfig(root, { RSP_MEASUREMENT_HOLDOUT_SHARE: "0" }, undefined).measurementHoldoutShare).toBe(0);
  });

  it("exposes the universal proxy flag separately from rsp enablement", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");

    const config = resolveRspConfig(root, {}, undefined);

    expect(config.enabled).toBe(true);
    expect(config.proxyEnabled).toBe(true);
  });

  it("honours an explicit rsp.proxy.enabled: false as the proxy opt-out", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: false\n", "utf8");

    const config = resolveRspConfig(root, {}, undefined);

    expect(config.enabled).toBe(true);
    expect(config.proxyEnabled).toBe(false);
  });

  it("lets env override the heavy git truncation threshold", async () => {
    const root = await tempRoot();
    const config = resolveRspConfig(root, { RSP_HEAVY_GIT_BYTE_THRESHOLD: "123" }, undefined);

    expect(config.heavyGitByteThreshold).toBe(123);
  });

  it("lets env override the telemetry drain interval", async () => {
    const root = await tempRoot();
    const config = resolveRspConfig(root, { RSP_TELEMETRY_DRAIN_INTERVAL_MS: "123" }, undefined);

    expect(config.telemetryDrainIntervalMs).toBe(123);
  });

  it("lets env override the telemetry drain timeout", async () => {
    const root = await tempRoot();
    const config = resolveRspConfig(root, { RSP_TELEMETRY_DRAIN_TIMEOUT_MS: "456" }, undefined);

    expect(config.telemetryDrainTimeoutMs).toBe(456);
  });

  it("lets env override the resident idle timeout", async () => {
    const root = await tempRoot();
    const config = resolveRspConfig(root, { RSP_IDLE_MS: "6000" }, undefined);

    expect(config.idleMs).toBe(6_000);
  });

  it("floors configured resident idle timeout at five seconds", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  idleMs: 1000\n", "utf8");

    expect(resolveRspConfig(root, {}, undefined).idleMs).toBe(MIN_RSP_IDLE_MS);
    expect(resolveRspConfig(root, { RSP_IDLE_MS: "2000" }, undefined).idleMs).toBe(MIN_RSP_IDLE_MS);
  });

  it("does not create .red or red-skills.rdb while resolving runtime config", async () => {
    const root = await tempRoot();
    const config = resolveRspConfig(root, {}, undefined);

    expect(config.enabled).toBe(false);
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails clearly instead of opening a legacy tmp-tier shared store", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "tmp"), { recursive: true });
    await writeFile(join(root, ".red", "tmp", "red-skills.rdb"), "legacy", "utf8");

    expect(() => resolveRspConfig(root, {}, undefined)).toThrow(
      "Run `rsp setup` to migrate it to .red/state/red-skills.rdb",
    );
  });
});
