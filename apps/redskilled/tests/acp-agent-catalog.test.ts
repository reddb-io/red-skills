import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_AGENT_CATALOG,
  ACP_UNATTENDED_POSTURES,
  ACP_AGENT_IDS,
  ACP_AGENT_REQUIRED_CAPABILITIES,
  AcpAgentCatalog,
  AcpAgentUnavailableError,
  type AcpAgentDescriptor,
  type AcpEndpoint,
} from "../src/acp-agent-catalog.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the host-scoped ACP Agent catalog", () => {
  it("pins the five supported Agents and keeps adapters outside the native boundary", () => {
    expect(ACP_AGENT_IDS).toEqual(["redcode", "claude-code", "codex", "pi", "opencode"]);
    expect(ACP_AGENT_CATALOG.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "redcode", kind: "native" },
      { id: "claude-code", kind: "adapter" },
      { id: "codex", kind: "adapter" },
      { id: "pi", kind: "adapter" },
      { id: "opencode", kind: "native" },
    ]);

    expect(ACP_AGENT_CATALOG.filter((agent) => agent.kind === "native").map((agent) => agent.command)).toEqual([
      ["redcode", "acp"],
      ["opencode", "acp"],
    ]);
    for (const descriptor of ACP_AGENT_CATALOG.filter((agent) => agent.kind === "adapter")) {
      expect(descriptor.artifact.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(descriptor.artifact.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
      expect(descriptor.artifact.package).not.toContain("@latest");
    }
  });

  it("provisions every Agent only after the shared capability probe passes", async () => {
    const root = await temporaryRoot();
    const installed: string[] = [];
    const catalog = new AcpAgentCatalog({
      root,
      fetchArtifact: async (artifact) => bytesFor(artifact.package, artifact.version),
      installArtifact: async (_bytes, stage, descriptor) => {
        installed.push(descriptor.id);
        const entry = join(stage, descriptor.artifact.entrypoint);
        await mkdir(join(entry, ".."), { recursive: true });
        await writeFile(entry, "healthy adapter", "utf8");
      },
      probe: healthyProbe,
      descriptors: descriptorsWithFixtureIntegrity(),
    });

    const result = await catalog.provisionAll();

    expect(result.map(({ id, status }) => ({ id, status }))).toEqual(
      ACP_AGENT_IDS.map((id) => ({ id, status: "healthy" })),
    );
    expect(installed).toEqual(["claude-code", "codex", "pi"]);
    for (const id of ACP_AGENT_IDS) {
      expect(await catalog.resolveForWorker(id)).toMatchObject({ agent: id, transport: "stdio" });
    }
  });

  it("keeps the last healthy adapter active when a pinned update fails integrity", async () => {
    const root = await temporaryRoot();
    const initial = adapterDescriptor("pi", "1.0.0", bytesFor("pi-acp", "1.0.0"));
    const first = catalogFor(root, initial, bytesFor("pi-acp", "1.0.0"));
    await expect(first.provision("pi")).resolves.toMatchObject({ status: "healthy", version: "1.0.0" });
    const prior = await first.resolveForWorker("pi");

    const corrupt = adapterDescriptor("pi", "2.0.0", bytesFor("pi-acp", "2.0.0"));
    const update = catalogFor(root, corrupt, Buffer.from("substituted bytes"));
    const receipt = await update.provision("pi");

    expect(receipt).toMatchObject({ status: "healthy", version: "1.0.0", preserved: true });
    expect(receipt.warning).toMatch(/integrity/i);
    expect(await update.resolveForWorker("pi")).toEqual(prior);
  });

  it("keeps the last healthy adapter active when an update misses a baseline capability", async () => {
    const root = await temporaryRoot();
    const initialBytes = bytesFor("pi-acp", "1.0.0");
    const initial = adapterDescriptor("pi", "1.0.0", initialBytes);
    const first = catalogFor(root, initial, initialBytes);
    await first.provision("pi");

    const updateBytes = bytesFor("pi-acp", "2.0.0");
    const update = adapterDescriptor("pi", "2.0.0", updateBytes);
    const catalog = catalogFor(root, update, updateBytes, async (endpoint) => ({
      protocolVersion: 1,
      capabilities: endpoint.args.some((arg) => arg.includes("2.0.0"))
        ? ["session/new", "session/prompt"]
        : ACP_AGENT_REQUIRED_CAPABILITIES,
    }));

    await expect(catalog.provision("pi")).resolves.toMatchObject({
      status: "healthy",
      version: "1.0.0",
      preserved: true,
      warning: expect.stringMatching(/session\/cancel/),
    });
  });

  it("refuses an unavailable selection without routing to another Agent or leaking auth", async () => {
    const root = await temporaryRoot();
    const catalog = new AcpAgentCatalog({
      root,
      probe: async () => {
        throw new Error("command not found");
      },
      descriptors: ACP_AGENT_CATALOG,
    });

    await expect(catalog.resolveForWorker("redcode")).rejects.toEqual(expect.objectContaining({
      name: "AcpAgentUnavailableError",
      agent: "redcode",
      message: expect.stringMatching(/redcode.*not available.*provision/i),
    } satisfies Partial<AcpAgentUnavailableError>));
    await expect(catalog.resolveForWorker("opencode")).rejects.toMatchObject({ agent: "opencode" });

    const endpoint = await new AcpAgentCatalog({ root, probe: healthyProbe }).resolveForWorker("redcode");
    expect(endpoint).toEqual({ agent: "redcode", transport: "stdio", command: "redcode", args: ["acp"] });
    expect(JSON.stringify(endpoint)).not.toMatch(/token|secret|api.?key|auth/i);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-acp-agent-catalog-"));
  roots.push(root);
  return root;
}

function bytesFor(packageName: string, version: string): Buffer {
  return Buffer.from(`${packageName}@${version}`);
}

function integrityOf(bytes: Uint8Array): `sha512-${string}` {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function descriptorsWithFixtureIntegrity(): readonly AcpAgentDescriptor[] {
  return ACP_AGENT_CATALOG.map((descriptor) => descriptor.kind === "native" ? descriptor : ({
    ...descriptor,
    artifact: {
      ...descriptor.artifact,
      integrity: integrityOf(bytesFor(descriptor.artifact.package, descriptor.artifact.version)),
    },
  }));
}

function adapterDescriptor(id: "pi", version: string, bytes: Uint8Array): AcpAgentDescriptor {
  return {
    id,
    label: "Pi",
    kind: "adapter",
    artifact: {
      package: "pi-acp",
      version,
      integrity: integrityOf(bytes),
      entrypoint: "package/dist/index.js",
    },
    unattendedPosture: ACP_UNATTENDED_POSTURES.pi,
  };
}

function catalogFor(
  root: string,
  descriptor: AcpAgentDescriptor,
  fetched: Uint8Array,
  probe: (endpoint: AcpEndpoint) => Promise<{ protocolVersion: number; capabilities: readonly string[] }> = healthyProbe,
): AcpAgentCatalog {
  return new AcpAgentCatalog({
    root,
    descriptors: [descriptor],
    fetchArtifact: async () => fetched,
    installArtifact: async (_bytes, stage, selected) => {
      if (selected.kind !== "adapter") throw new Error("expected an adapter");
      const entry = join(stage, selected.artifact.entrypoint);
      await mkdir(join(entry, ".."), { recursive: true });
      await writeFile(entry, "adapter", "utf8");
    },
    probe,
  });
}

async function healthyProbe(): Promise<{ protocolVersion: number; capabilities: readonly string[] }> {
  return { protocolVersion: 1, capabilities: ACP_AGENT_REQUIRED_CAPABILITIES };
}
