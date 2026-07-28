// ADR 0126 contract: the resident is the single core, every surface is a client.
//
// Slice 1 of Spec #2651 is the gate for the big-bang cutover — the migration was
// accepted with no partial rollback specifically because this test lands first.
// It therefore has to fail loudly if any surface grows its own store instance or
// stops honoring the fail-open guarantee, not merely if the happy path breaks.
import { describe, expect, it } from "vitest";
import { resolveRspConfig } from "../src/config.js";
import { ResidentRspElisionStore, resolveResidentPaths } from "../src/resident-client.js";
import {
  buildBundleOnce,
  commitMany,
  countTrackedResidentProcesses,
  decode,
  expectWarmResident,
  extractHandle,
  initGitRepo,
  installRspShim,
  isRecord,
  join,
  normalizedDurationMs,
  runBundleFromCwd,
  runGit,
  runShellFromCwd,
  seedWarmRedCache,
  stat,
  trackedResidentPaths,
  writeFile,
} from "./cli.helpers.js";

const HANDLE_SHAPE = /^el:[a-f0-9]{12}$/;
const HANDLE_ANYWHERE = /el:[a-f0-9]{12}/;

/** One fixed command for the whole parity assertion. */
const FIXED_COMMAND = "git log";

describe("rsp surface parity (ADR 0126)", () => {
  it("routes every surface through the one resident core for a single fixed command", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    // RSP_FAIL_IF_STORE_OPEN turns "this surface opened its own store instead of
    // asking the resident" from an invisible regression into a hard failure.
    const env = { RED_SKILLS_CACHE_DIR: cacheDir, RSP_FAIL_IF_STORE_OPEN: "1" };
    const setup = runBundleFromCwd(root, ["setup"], env);
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, env);
    const proxyEnv = { ...env, PATH: await installRspShim(root) };

    // Surface 1 — the CLI wrapper.
    const cliRun = runBundleFromCwd(root, ["--terse", "git", "log"], env);
    expect(cliRun.status, `${cliRun.stdout.toString("utf8")}${cliRun.stderr.toString("utf8")}`).toBe(0);
    expect(cliRun.stderr).toEqual(Buffer.alloc(0));

    // Surface 2 — the pre-exec proxy, rewriting the same command line.
    const proxyRun = runBundleFromCwd(root, ["--terse", "proxy", "--", FIXED_COMMAND], proxyEnv);
    expect(proxyRun.status, `${proxyRun.stdout.toString("utf8")}${proxyRun.stderr.toString("utf8")}`).toBe(0);
    expect(proxyRun.stderr).toEqual(Buffer.alloc(0));

    // Same summary text, byte for byte, and the same content-addressed handle:
    // two surfaces reaching two stores could not agree on both.
    expect(proxyRun.stdout).toEqual(cliRun.stdout);
    const cliHandle = extractHandle(cliRun.stdout);
    const proxyHandle = extractHandle(proxyRun.stdout);
    expect(cliHandle).toMatch(HANDLE_SHAPE);
    expect(proxyHandle).toBe(cliHandle);

    const recovered = runBundleFromCwd(root, ["show", cliHandle], env);
    expect(recovered.status, `${recovered.stdout.toString("utf8")}${recovered.stderr.toString("utf8")}`).toBe(0);
    const payload = recovered.stdout;
    expect(payload.length).toBeGreaterThan(cliRun.stdout.length);

    // Surface 3 — the MCP tool, minting the very same bytes.
    const mcpResponses = await runMcpCalls(root, [
      { name: "rsp_compress", arguments: { payload: payload.toString("utf8"), level: "terse" } },
      { name: "rsp_show", arguments: { handle: cliHandle } },
    ], env);
    const compressText = toolText(mcpResponses[0]);
    const mcpHandle = extractHandleFromText(compressText);
    expect(mcpHandle).toMatch(HANDLE_SHAPE);
    // A different command identity, so a different handle — but the same store.
    expect(mcpHandle).not.toBe(cliHandle);
    expect(decode(toolText(mcpResponses[1]))).toMatchObject({
      handle: cliHandle,
      found: true,
      text: payload.toString("utf8"),
    });

    // Surface 4 — a direct resident client call.
    const config = resolveRspConfig(root, process.env);
    const direct = new ResidentRspElisionStore(resolveResidentPaths(root), residentConfig(config), {
      ensureResident: false,
    });
    const bytesElided = elidedBytes(cliRun.stdout);
    const directSameCommand = await direct.mint(payload, {
      command: FIXED_COMMAND,
      loss: { level: "terse", bytes_elided: bytesElided },
    });
    // Same bytes and same command identity through the fourth door land on the
    // handle the CLI already minted: one core, not four.
    expect(directSameCommand).toBe(cliHandle);
    const directHandle = await direct.mint(payload, {
      command: "rsp direct resident client",
      loss: { level: "terse", bytes_elided: payload.length },
    });
    expect(directHandle).toMatch(HANDLE_SHAPE);
    expect(directHandle).not.toBe(cliHandle);

    // Every handle recovers byte-identical output, whichever surface minted it
    // and whichever surface reads it back.
    for (const handle of [cliHandle, proxyHandle, mcpHandle, directHandle]) {
      const shown = runBundleFromCwd(root, ["show", handle], env);
      expect(shown.status, `${shown.stdout.toString("utf8")}${shown.stderr.toString("utf8")}`).toBe(0);
      expect(shown.stdout).toEqual(payload);
      const record = await direct.get(handle);
      expect(record && "original" in record ? record.original : null).toEqual(payload);
    }
    const mcpCrossRead = await runMcpCalls(root, [
      { name: "rsp_show", arguments: { handle: directHandle } },
    ], env);
    expect(decode(toolText(mcpCrossRead[0]))).toMatchObject({
      handle: directHandle,
      found: true,
      text: payload.toString("utf8"),
    });

    // ...and all of it came from a single resident process.
    expect(await countTrackedResidentProcesses([root])).toBe(1);
    const status = runBundleFromCwd(root, ["status"], env);
    expect(decode(status.stdout.toString("utf8"))).toMatchObject({
      state: "registered-alive-socket-healthy",
      entry: expect.objectContaining({ store_uri: config.storeUri }),
    });
  }, 180_000);

  it("fails open on every surface when the resident socket is unreachable", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await writeFile(join(root, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
    expect(runGit(["-C", root, "add", "notes.txt"]).status).toBe(0);
    expect(runGit(["-C", root, "commit", "-m", "seed"]).status).toBe(0);
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    // Make the socket unreachable for good: the runtime socket directory hangs
    // off XDG_RUNTIME_DIR, so pointing that at a regular file means no surface
    // can connect to a resident or spawn one.
    const brokenXdg = join(root, "xdg-not-a-directory");
    await writeFile(brokenXdg, "not a directory\n", "utf8");
    const env = {
      RED_SKILLS_CACHE_DIR: cacheDir,
      XDG_RUNTIME_DIR: brokenXdg,
      RSP_FAIL_IF_STORE_OPEN: "1",
      RSP_RESIDENT_READY_TIMEOUT_MS: String(normalizedDurationMs(1_000)),
    };
    const proxyEnv = { ...env, PATH: await installRspShim(root) };
    await expect(stat(trackedResidentPaths(root).socketPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The CLI wrapper and the proxy both hand back the raw command verbatim.
    const rawCat = runShellFromCwd(root, "cat notes.txt");
    for (const [label, res] of [
      ["cli", runBundleFromCwd(root, ["cat", "notes.txt"], env)],
      ["proxy", runBundleFromCwd(root, ["proxy", "--", "cat notes.txt"], proxyEnv)],
    ] as const) {
      expect(res.stdout, label).toEqual(rawCat.stdout);
      expect(res.stderr, label).toEqual(rawCat.stderr);
      expect(res.status, label).toBe(rawCat.status);
      expect(res.stdout.toString("utf8"), label).not.toMatch(HANDLE_ANYWHERE);
    }

    // A failing command keeps its stderr and its exit status through the proxy.
    const failing = "sh -c 'printf out; printf err 1>&2; exit 7'";
    const rawFailing = runShellFromCwd(root, failing);
    const proxiedFailing = runBundleFromCwd(root, ["proxy", "--", failing], proxyEnv);
    expect(proxiedFailing.stdout).toEqual(rawFailing.stdout);
    expect(proxiedFailing.stderr).toEqual(rawFailing.stderr);
    expect(proxiedFailing.status).toBe(7);

    // Where the wrapper still summarizes, it mints no handle it cannot honor —
    // it names the re-run instead, identically on both surfaces.
    const rawLog = runGit(["-C", root, "log"]);
    const cliLog = runBundleFromCwd(root, ["--terse", "git", "log"], env);
    const proxyLog = runBundleFromCwd(root, ["--terse", "proxy", "--", FIXED_COMMAND], proxyEnv);
    expect(cliLog.stdout).toEqual(proxyLog.stdout);
    expect(cliLog.stdout.toString("utf8")).not.toMatch(HANDLE_ANYWHERE);
    expect(cliLog.stdout.toString("utf8")).toContain(`re-run: ${FIXED_COMMAND}`);
    expect(cliLog.stderr).toEqual(rawLog.stderr);
    expect(cliLog.status).toBe(rawLog.status);

    // The MCP tool returns the payload it was handed rather than an error.
    const payload = rawLog.stdout.toString("utf8");
    const mcpResponses = await runMcpCalls(root, [
      { name: "rsp_compress", arguments: { payload, level: "terse" } },
    ], env);
    expect(mcpResponses[0]).not.toHaveProperty("isError", true);
    const compressText = toolText(mcpResponses[0]);
    expect(compressText).toBe(`${payload}`);
    expect(compressText).not.toMatch(HANDLE_ANYWHERE);

    // A direct client call has no raw command to fall back to, so it rejects
    // cleanly instead of handing back a handle nothing can recover.
    const config = resolveRspConfig(root, process.env);
    const previousXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = brokenXdg;
    try {
      const direct = new ResidentRspElisionStore(resolveResidentPaths(root), residentConfig(config), {
        ensureResident: false,
      });
      await expect(direct.mint(Buffer.from(payload), {
        command: FIXED_COMMAND,
        loss: { level: "terse", bytes_elided: payload.length },
      })).rejects.toThrow();
    } finally {
      if (previousXdg == null) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousXdg;
    }

    // Nothing was quietly started or written on the side.
    await expect(stat(trackedResidentPaths(root).socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await countTrackedResidentProcesses([root])).toBe(0);
  }, 180_000);
});

function residentConfig(config: ReturnType<typeof resolveRspConfig>) {
  return {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
  };
}

async function runMcpCalls(
  root: string,
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  env: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const { runMcpRequests } = await import("./cli.helpers.js");
  const requests = [
    { jsonrpc: "2.0", id: 0, method: "initialize" },
    ...calls.map((params, index) => ({ jsonrpc: "2.0", id: index + 1, method: "tools/call", params })),
  ];
  const responses = await runMcpRequests(root, requests, "bundle", env);
  return calls.map((_call, index) => {
    const response = responses.find((entry) => entry.id === index + 1);
    expect(response, `missing MCP response ${index + 1}`).toBeTruthy();
    expect(response, `MCP call ${index + 1} errored`).not.toHaveProperty("error");
    const result = (response as { result?: unknown }).result;
    expect(isRecord(result), `MCP call ${index + 1} returned no result`).toBe(true);
    return result as Record<string, unknown>;
  });
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content;
  expect(Array.isArray(content)).toBe(true);
  const first = (content as unknown[])[0];
  expect(isRecord(first) && typeof first.text === "string").toBe(true);
  return (first as { text: string }).text;
}

function extractHandleFromText(text: string): string {
  const match = HANDLE_ANYWHERE.exec(text);
  expect(match?.[0], `no elision handle in ${text}`).toBeTruthy();
  return match![0];
}

function elidedBytes(stdout: Buffer): number {
  const match = /\(\+(\d+)\)/.exec(stdout.toString("utf8"));
  expect(match?.[1], "no elided byte count in wrapper summary").toBeTruthy();
  return Number(match![1]);
}
