import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEnginePaths } from "./paths.js";
import { createSingletonEventLane } from "./singleton-event-lane.js";
import {
  readHostCapabilityProfile,
  resolveHostCapabilities,
  writeHostCapabilityProfile,
  type HostCapabilityProfile,
} from "./host-capability-profile.js";

describe("host capability profile", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("round-trips one host's capabilities through the durable Castle state tier", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-host-capabilities-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));
    const profile: HostCapabilityProfile = {
      machineIdHash: "8cb3eafdcbd2",
      runners: ["codex", "opencode"],
      maxGateWeight: "heavy-cone",
      defaultFleetWidth: 3,
    };

    await writeHostCapabilityProfile(paths, profile);

    expect(await readHostCapabilityProfile(paths)).toEqual(profile);
  });

  it("registers a present profile in the singleton event lane without raw machine identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-host-registration-"));
    roots.push(root);
    const paths = createEnginePaths(join(root, ".red"));

    await writeHostCapabilityProfile(paths, {
      machineIdHash: "8cb3eafdcbd2",
      runners: ["codex"],
      maxGateWeight: "light-cone",
      defaultFleetWidth: 1,
    });

    const events = await createSingletonEventLane(paths).read();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      singleton: "host-capabilities",
      kind: "host.capability-profile.registered",
      payload: {
        machine_id_hash: "8cb3eafdcbd2",
        runners: ["codex"],
        max_gate_weight: "light-cone",
        default_fleet_width: 1,
      },
    });
    expect(JSON.stringify(events[0])).not.toMatch(
      /hostname|home_path|username/,
    );
  });

  it("uses today's permissive runner, gate, and width defaults when no profile exists", () => {
    expect(resolveHostCapabilities(undefined)).toEqual({
      runners: ["claude", "codex", "hermes", "opencode", "claude-minimax"],
      maxGateWeight: "full-workspace",
      defaultFleetWidth: 2,
      source: "permissive-default",
    });
  });
});
