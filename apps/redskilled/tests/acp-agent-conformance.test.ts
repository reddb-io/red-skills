import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACP_AGENT_IDS, type AcpAgentId, type AcpEndpoint } from "@reddb-io/protocol-acp";

import {
  ACP_AGENT_CATALOG,
  ACP_AGENT_REQUIRED_CAPABILITIES,
  ACP_UNATTENDED_POSTURES,
  AcpAgentCatalog,
  declaredChildAgentEndpoint,
  type AcpAgentDescriptor,
  type AcpAgentProbeResult,
  type AcpUnattendedPosture,
} from "../src/acp-agent-catalog.js";

/**
 * The focused Agent conformance matrix (issue #3897).
 *
 * The broad `apps/redskilled` package gate is deliberately not a pull-request
 * requirement, so "every Agent is real" cannot be an emergent property of a
 * suite nobody runs on a PR. This matrix NAMES the five supported Agents and
 * PROBES each one through the same host-owned admission path a Worker reaches,
 * so a sixth Agent, a dropped Agent, or an Agent admitted without the baseline
 * capability probe fails one focused suite rather than none.
 */
interface AgentCase {
  readonly id: AcpAgentId;
  readonly label: string;
  readonly kind: "native" | "adapter";
  /** Native argv, executable first; adapters resolve their argv from the pin. */
  readonly command?: readonly [string, ...string[]];
  /**
   * The kind of unattended posture this Agent is expected to declare.
   *
   * Named here rather than read from the catalog: a matrix that reads the
   * catalog agrees with it by construction, and the whole failure this row
   * exists for is three Agents that were admissible and undeployable because
   * nobody had written down what makes them able to work (#4278).
   */
  readonly posture: AcpUnattendedPosture["kind"];
}

const AGENT_MATRIX: readonly AgentCase[] = [
  { id: "redcode", label: "Redcode", kind: "native", command: ["redcode", "acp"], posture: "none-needed" },
  { id: "claude-code", label: "Claude Code", kind: "adapter", posture: "session-mode" },
  { id: "codex", label: "Codex", kind: "adapter", posture: "launch-args" },
  { id: "pi", label: "Pi", kind: "adapter", posture: "none-needed" },
  { id: "opencode", label: "OpenCode", kind: "native", command: ["opencode", "acp"], posture: "none-needed" },
] as const;

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the focused ACP Agent conformance matrix", () => {
  it("names the five supported Agents, and the wire and the host catalog agree on them", () => {
    expect(AGENT_MATRIX.map((agent) => agent.id)).toEqual([...ACP_AGENT_IDS]);
    expect(AGENT_MATRIX.map((agent) => agent.label)).toEqual([
      "Redcode",
      "Claude Code",
      "Codex",
      "Pi",
      "OpenCode",
    ]);
    expect(ACP_AGENT_CATALOG.map(({ id, label, kind }) => ({ id, label, kind }))).toEqual(
      AGENT_MATRIX.map(({ id, label, kind }) => ({ id, label, kind })),
    );
  });

  it.each(AGENT_MATRIX)("probes $label at the ACP baseline before a Worker may reach it", async (agent) => {
    const probed: AcpEndpoint[] = [];
    const catalog = await catalogFor(agent, async (endpoint) => {
      probed.push(endpoint);
      return healthy();
    });

    const receipt = await catalog.provision(agent.id);
    expect(receipt).toMatchObject({ id: agent.id, status: "healthy" });

    const endpoint = await catalog.resolveForWorker(agent.id);
    expect(probed.length).toBeGreaterThan(0);
    for (const seen of probed) expect(seen.agent).toBe(agent.id);

    // The projection a Worker receives: this Agent, over stdio, with no host
    // credential riding along.
    expect(endpoint).toMatchObject({ agent: agent.id, transport: "stdio" });
    if (agent.command) expect([endpoint.command, ...endpoint.args]).toEqual([...agent.command]);
    expect(JSON.stringify(endpoint)).not.toMatch(/token|secret|api.?key|auth/i);
  });

  it.each(AGENT_MATRIX)(
    "refuses $label by name when a baseline capability is missing, and never substitutes another Agent",
    async (agent) => {
      const catalog = await catalogFor(agent, async () => ({
        protocolVersion: 1,
        capabilities: ACP_AGENT_REQUIRED_CAPABILITIES.filter((name) => name !== "session/cancel"),
      }));

      await expect(catalog.resolveForWorker(agent.id)).rejects.toMatchObject({
        name: "AcpAgentUnavailableError",
        agent: agent.id,
        message: expect.stringContaining("session/cancel"),
      });

      const failure = await catalog.resolveForWorker(agent.id).catch((error: Error) => error.message);
      for (const other of AGENT_MATRIX.filter((candidate) => candidate.id !== agent.id)) {
        expect(String(failure)).not.toContain(other.id);
      }
    },
  );

  it.each(AGENT_MATRIX)("refuses $label by name when its process boundary is unreachable", async (agent) => {
    const catalog = await catalogFor(agent, async () => {
      throw new Error("command not found");
    });

    await expect(catalog.resolveForWorker(agent.id)).rejects.toMatchObject({
      name: "AcpAgentUnavailableError",
      agent: agent.id,
      message: expect.stringMatching(new RegExp(`${agent.id}.*not available.*provision`, "i")),
    });
  });

  it.each(AGENT_MATRIX.filter((agent) => agent.kind === "adapter"))(
    "pins $label to an exact reviewed release rather than a floating range",
    (agent) => {
      const descriptor = descriptorFor(agent.id);
      expect(descriptor.kind).toBe("adapter");
      if (descriptor.kind !== "adapter") return;

      expect(descriptor.artifact.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(descriptor.artifact.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(descriptor.artifact.package).not.toMatch(/[\^~*]|@latest|@next/);
      expect(descriptor.artifact.entrypoint).toMatch(/^package\//);
    },
  );

  it.each(AGENT_MATRIX.filter((agent) => agent.kind === "native"))(
    "reaches $label as a native ACP Agent, with no adapter between the daemon and it",
    (agent) => {
      const descriptor = descriptorFor(agent.id);
      expect(descriptor.kind).toBe("native");
      if (descriptor.kind !== "native") return;

      expect([...descriptor.command]).toEqual([...(agent.command ?? [])]);
      expect(descriptor).not.toHaveProperty("artifact");
    },
  );

  it.each(AGENT_MATRIX)("declares how $label works with nobody at the keyboard", (agent) => {
    const posture = descriptorFor(agent.id).unattendedPosture;
    expect(posture.kind).toBe(agent.posture);
    // The catalog and the declaration table are the same object, never two
    // tables a reader has to reconcile.
    expect(posture).toBe(ACP_UNATTENDED_POSTURES[agent.id]);

    // A posture that establishes nothing is worse than none: it reads as a
    // decision somebody made. Every arm has to SAY something.
    if (posture.kind === "launch-args") {
      expect(posture.args.length).toBeGreaterThan(0);
      expect(posture.evidence.length).toBeGreaterThan(20);
    } else if (posture.kind === "session-mode") {
      expect(posture.modeId).not.toBe("");
      expect(posture.evidence.length).toBeGreaterThan(20);
    } else {
      expect(posture.reason.length).toBeGreaterThan(20);
    }
  });

  it("declares a posture for every catalog Agent and only for catalog Agents", () => {
    // Direction one: no Agent is admissible without a stated posture. This is
    // the drift that shipped — claude-code, pi and opencode were each reachable
    // and each unable to finish a turn.
    for (const descriptor of ACP_AGENT_CATALOG) {
      expect(ACP_UNATTENDED_POSTURES[descriptor.id]).toBe(descriptor.unattendedPosture);
    }
    // Direction two: a posture for an Agent nobody can reach is fiction that
    // outlives the Agent it described.
    expect(Object.keys(ACP_UNATTENDED_POSTURES).sort())
      .toEqual(ACP_AGENT_CATALOG.map((descriptor) => descriptor.id).sort());
  });

  it.each(AGENT_MATRIX)("carries $label's posture on the endpoint a Worker is handed", (agent) => {
    const endpoint = declaredChildAgentEndpoint(agent.id);
    const posture = ACP_UNATTENDED_POSTURES[agent.id];

    // A posture declared and not carried is a posture that never happened: the
    // endpoint is the ONLY thing that crosses the body/control cut.
    if (posture.kind === "launch-args") {
      expect(endpoint.args.slice(-posture.args.length)).toEqual([...posture.args]);
      expect(endpoint.unattendedSessionMode).toBeUndefined();
    } else if (posture.kind === "session-mode") {
      expect(endpoint.unattendedSessionMode).toBe(posture.modeId);
    } else {
      expect(endpoint.unattendedSessionMode).toBeUndefined();
      if (agent.command) expect([endpoint.command, ...endpoint.args]).toEqual([...agent.command]);
    }
  });

  it("demands the same baseline capabilities of every Agent in the matrix", () => {
    expect([...ACP_AGENT_REQUIRED_CAPABILITIES]).toEqual([
      "session/new",
      "session/prompt",
      "session/cancel",
    ]);
    expect(AGENT_MATRIX).toHaveLength(ACP_AGENT_CATALOG.length);
  });
});

function descriptorFor(id: AcpAgentId): AcpAgentDescriptor {
  const descriptor = ACP_AGENT_CATALOG.find((candidate) => candidate.id === id);
  if (descriptor == null) throw new Error(`${id} is absent from the host catalog`);
  return descriptor;
}

/**
 * One Agent's catalog, with the fixture bytes an adapter needs already staged so
 * the matrix exercises the SAME admission path for every row. Only the probe —
 * the process boundary the host cannot reach in a unit suite — is a seam, and
 * staging uses its own healthy probe so a row that degrades the probe is testing
 * ADMISSION rather than a release it never managed to activate.
 */
async function catalogFor(
  agent: AgentCase,
  probe: (endpoint: AcpEndpoint) => Promise<AcpAgentProbeResult>,
): Promise<AcpAgentCatalog> {
  const root = await mkdtemp(join(tmpdir(), `redskilled-acp-conformance-${agent.id}-`));
  roots.push(root);
  const descriptor = withFixtureIntegrity(descriptorFor(agent.id));
  const catalogWith = (seam: (endpoint: AcpEndpoint) => Promise<AcpAgentProbeResult>): AcpAgentCatalog =>
    new AcpAgentCatalog({
      root,
      descriptors: [descriptor],
      fetchArtifact: async (artifact) => fixtureBytes(artifact.package, artifact.version),
      installArtifact: async (_bytes, stage, selected) => {
        if (selected.kind !== "adapter") throw new Error("expected an adapter");
        const entry = join(stage, selected.artifact.entrypoint);
        await mkdir(join(entry, ".."), { recursive: true });
        await writeFile(entry, `${selected.id} adapter`, "utf8");
      },
      probe: seam,
    });

  // An adapter is only reachable once its pinned release is activated; a native
  // Agent has nothing to stage.
  if (descriptor.kind === "adapter") {
    const staged = await catalogWith(async () => healthy()).provision(agent.id);
    expect(staged, `${agent.id} could not be staged`).toMatchObject({ status: "healthy" });
  }
  return catalogWith(probe);
}

function withFixtureIntegrity(descriptor: AcpAgentDescriptor): AcpAgentDescriptor {
  if (descriptor.kind === "native") return descriptor;
  const bytes = fixtureBytes(descriptor.artifact.package, descriptor.artifact.version);
  return {
    ...descriptor,
    artifact: {
      ...descriptor.artifact,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
  };
}

function fixtureBytes(packageName: string, version: string): Buffer {
  return Buffer.from(`${packageName}@${version}`);
}

function healthy(): AcpAgentProbeResult {
  return { protocolVersion: 1, capabilities: ACP_AGENT_REQUIRED_CAPABILITIES };
}
