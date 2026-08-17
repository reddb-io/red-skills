import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRedskilledClientEndpoint } from "../src/client-rendezvous.js";
import {
  createRedskilledMachineClaimStore,
  currentMachineOwner,
} from "../src/machine-scope.js";
import { resolveRedskilledPaths } from "../src/paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACP client rendezvous", () => {
  it("routes both daemon endpoints through a same-user machine claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-rendezvous-"));
    roots.push(root);
    const claimPath = join(root, "machine", "claim.toon");
    const owner = resolveRedskilledPaths({
      runtimeDir: join(root, "owner"),
      machineClaimPath: claimPath,
      homeDir: root,
    });
    const client = resolveRedskilledPaths({
      runtimeDir: join(root, "client"),
      machineClaimPath: claimPath,
      homeDir: root,
    });
    const store = createRedskilledMachineClaimStore(claimPath, {
      machineIdHash: owner.machineIdHash,
      sessionKeyHash: owner.sessionKeyHash,
      socketPath: owner.socketPath,
    });
    expect((await store.claim(currentMachineOwner())).claimed).toBe(true);

    const endpoint = await resolveRedskilledClientEndpoint(client);

    expect(endpoint.joined).toBe(true);
    expect(endpoint.paths.socketPath).toBe(owner.socketPath);
    expect(endpoint.paths.acpSocketPath).toBe(join(owner.runtimeDir, basename(client.acpSocketPath)));
  });

  it("derives the owning ACP named pipe from the claim's session hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-acp-rendezvous-win-"));
    roots.push(root);
    const claimPath = join(root, "machine", "claim.toon");
    const owner = resolveRedskilledPaths({
      platform: "win32",
      runtimeDir: join(root, "owner"),
      machineClaimPath: claimPath,
      homeDir: root,
      env: { REDSKILLED_SESSION: "owner" },
    });
    const client = resolveRedskilledPaths({
      platform: "win32",
      runtimeDir: join(root, "client"),
      machineClaimPath: claimPath,
      homeDir: root,
      env: { REDSKILLED_SESSION: "client" },
    });
    const store = createRedskilledMachineClaimStore(claimPath, {
      machineIdHash: owner.machineIdHash,
      sessionKeyHash: owner.sessionKeyHash,
      socketPath: owner.socketPath,
    });
    expect((await store.claim(currentMachineOwner())).claimed).toBe(true);

    const endpoint = await resolveRedskilledClientEndpoint(client);

    expect(endpoint.paths.acpSocketPath).toBe(`\\\\.\\pipe\\redskilled-${owner.sessionKeyHash}-acp`);
  });
});
