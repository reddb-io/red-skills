import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_MEMORY_CEILING_FRACTION,
  REDSKILLED_MEMORY_CEILING_ENV,
  REDSKILLED_WORKER_CEILING_ENV,
  resolveHostCeiling,
  setHostCeilingWarningSink,
} from "../src/admission.js";
import {
  REDSKILLED_IDLE_MS_ENV,
  readRedskilledHostConfig,
  resolveRedskilledHostEventSinks,
  resolveRedskilledHostSettings,
} from "../src/host-config.js";
import { provisionRedskilledHome } from "../src/provision.js";

const roots: string[] = [];
const TOTAL = 16_000_000_000;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fakeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-host-config-"));
  roots.push(root);
  return root;
}

describe("the daemon-owned host config", () => {
  it("reads host settings only from ~/.red/config.yaml", async () => {
    const home = await fakeHome();
    await mkdir(join(home, ".red"), { recursive: true });
    await writeFile(join(home, ".red", "config.yaml"), [
      "plugins:",
      "  dev:",
      "    redskilled:",
      "      worker_ceiling: 6",
      "      memory_ceiling: 8G",
      "      validation_ceiling: 3",
      "      idle_ms: 61000",
      "      hooks:",
      "        worker-birth:",
      "          argv: [/usr/local/bin/redwall, refresh]",
      "          env:",
      "            REDWALL_MODE: live",
      "      notifications:",
      "        - worker-death",
      "        - worker-budget-kill",
      "",
    ].join("\n"));

    await expect(readRedskilledHostConfig(home)).resolves.toEqual({
      workerCeiling: "6",
      memoryCeiling: "8G",
      validationCeiling: "3",
      idleMs: "61000",
      hooks: {
        "worker-birth": {
          argv: ["/usr/local/bin/redwall", "refresh"],
          env: { REDWALL_MODE: "live" },
        },
      },
      notifications: ["worker-death", "worker-budget-kill"],
    });
  });

  it("is created only through provisioning and is never overwritten", async () => {
    const home = await fakeHome();
    const first = await provisionRedskilledHome(home);
    expect(first.configCreated).toBe(true);
    expect(await readFile(join(home, ".red", "config.yaml"), "utf8")).toContain("redskilled:");

    await writeFile(join(home, ".red", "config.yaml"), "operator: owned\n");
    const second = await provisionRedskilledHome(home);
    expect(second.configCreated).toBe(false);
    expect(await readFile(join(home, ".red", "config.yaml"), "utf8")).toBe("operator: owned\n");
  });
});

describe("host setting precedence", () => {
  it("turns persistent policy into daemon event sinks rooted in the host home", () => {
    expect(resolveRedskilledHostEventSinks({
      hooks: { "worker-birth": { argv: ["redwall", "refresh"] } },
      notifications: ["worker-death"],
    }, "/operator/redskilled", "darwin")).toEqual({
      workspacePath: "/operator/redskilled",
      hooks: { "worker-birth": { argv: ["redwall", "refresh"] } },
      notifications: ["worker-death"],
      platform: "darwin",
    });
    expect(resolveRedskilledHostEventSinks({}, "/operator/redskilled")).toBeUndefined();
  });

  it("resolves flag over environment over home config over the derived default", () => {
    const fromFlag = resolveHostCeiling(
      { [REDSKILLED_WORKER_CEILING_ENV]: "5", [REDSKILLED_MEMORY_CEILING_ENV]: "7G" },
      TOTAL,
      {
        flags: { workerCeiling: "4", memoryCeiling: "6G" },
        config: { workerCeiling: "6", memoryCeiling: "8G" },
      },
    );
    expect(fromFlag).toMatchObject({ worker_count: 4, memory_bytes: 6 * 1024 ** 3 });
    expect(fromFlag.worker_source).toBe("flag");
    expect(fromFlag.memory_source).toBe("flag");

    const fromEnv = resolveHostCeiling(
      { [REDSKILLED_WORKER_CEILING_ENV]: "5", [REDSKILLED_MEMORY_CEILING_ENV]: "7G" },
      TOTAL,
      { config: { workerCeiling: "6", memoryCeiling: "8G" } },
    );
    expect(fromEnv.worker_count).toBe(5);
    expect(fromEnv.worker_source).toBe("environment");
    expect(fromEnv.memory_source).toBe("environment");

    const fromConfig = resolveHostCeiling({}, TOTAL, {
      config: { workerCeiling: "6", memoryCeiling: "8G" },
    });
    expect(fromConfig.worker_count).toBe(6);
    expect(fromConfig.worker_source).toBe("home-config");
    expect(fromConfig.memory_source).toBe("home-config");

    const derived = resolveHostCeiling({}, TOTAL);
    expect(derived.worker_count).toBeNull();
    expect(derived.worker_source).toBe("derived-default");
    expect(derived.memory_bytes).toBe(Math.floor(TOTAL * DEFAULT_HOST_MEMORY_CEILING_FRACTION));
    expect(derived.memory_source).toBe("derived-default");
  });

  it("warns about a malformed home value and keeps the host running", () => {
    const warnings: string[] = [];
    const previous = setHostCeilingWarningSink((message) => warnings.push(message));
    try {
      const ceiling = resolveHostCeiling({}, TOTAL, { config: { workerCeiling: "many" } });
      expect(ceiling.worker_count).toBeNull();
      expect(ceiling.worker_source).toBe("derived-default");
      expect(warnings.join("\n")).toContain("home config");
      expect(warnings.join("\n")).toContain("many");
    } finally {
      setHostCeilingWarningSink(previous);
    }
  });

  it("resolves idle time with the same precedence", () => {
    expect(resolveRedskilledHostSettings({
      flags: { idleMs: 40_000 },
      env: { [REDSKILLED_IDLE_MS_ENV]: "50000" },
      config: { idleMs: "60000" },
      totalMemoryBytes: TOTAL,
    })).toMatchObject({ idleMs: 40_000, idleMsSource: "flag" });
    expect(resolveRedskilledHostSettings({
      env: { [REDSKILLED_IDLE_MS_ENV]: "50000" },
      config: { idleMs: "60000" },
      totalMemoryBytes: TOTAL,
    })).toMatchObject({ idleMs: 50_000, idleMsSource: "environment" });
    expect(resolveRedskilledHostSettings({
      env: {},
      config: { idleMs: "60000" },
      totalMemoryBytes: TOTAL,
    })).toMatchObject({ idleMs: 60_000, idleMsSource: "home-config" });
  });

  it("derives validation slots from the tightest CPU, memory, and Worker ceiling", () => {
    const settings = resolveRedskilledHostSettings({
      env: {},
      config: { workerCeiling: "3", memoryCeiling: "16G" },
      totalMemoryBytes: 32 * 1024 ** 3,
      availableParallelism: 12,
    });

    expect(settings.ceiling.validation_count).toBe(3);
    expect(settings.ceiling.validation_source).toBe("derived-default");
  });

  it("keeps a small host at one validation slot and lets the operator declare K = 1", () => {
    const derived = resolveRedskilledHostSettings({
      env: {},
      totalMemoryBytes: 2 * 1024 ** 3,
      availableParallelism: 2,
    });
    expect(derived.ceiling.validation_count).toBe(1);

    const declared = resolveRedskilledHostSettings({
      env: {},
      config: { validationCeiling: "1" },
      totalMemoryBytes: 64 * 1024 ** 3,
      availableParallelism: 32,
    });
    expect(declared.ceiling.validation_count).toBe(1);
    expect(declared.ceiling.validation_source).toBe("home-config");
  });
});
