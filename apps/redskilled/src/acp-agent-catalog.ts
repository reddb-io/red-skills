/**
 * Host-scoped ACP Agent catalog.
 *
 * redskilled owns discovery, adapter updates, integrity checks and capability
 * admission. A Worker receives only the selected stdio endpoint; package pins,
 * download locations, host credentials and fallback policy stay on this side
 * of the daemon boundary.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { ACP_AGENT_IDS, type AcpAgentId, type AcpEndpoint } from "@reddb-io/protocol-acp";

// The Agent identities and the resolved endpoint are shared wire (ADR 0148):
// the Worker body reads an endpoint it never resolves, so it must not have to
// import this catalog to do it. Re-exported here so daemon-side callers keep
// asking the authority that owns discovery.
export { ACP_AGENT_IDS, type AcpAgentId, type AcpEndpoint };

export const ACP_AGENT_REQUIRED_CAPABILITIES = [
  "session/new",
  "session/prompt",
  "session/cancel",
] as const;

export interface AcpAdapterArtifact {
  readonly package: string;
  readonly version: string;
  /** npm Subresource Integrity, pinned with the package version. */
  readonly integrity: `sha512-${string}`;
  /** Entrypoint inside the unpacked npm artifact. */
  readonly entrypoint: string;
}

export interface NativeAcpAgentDescriptor {
  readonly id: AcpAgentId;
  readonly label: string;
  readonly kind: "native";
  /** Native ACP argv; the first element is the executable. */
  readonly command: readonly [string, ...string[]];
}

export interface AdapterAcpAgentDescriptor {
  readonly id: AcpAgentId;
  readonly label: string;
  readonly kind: "adapter";
  readonly artifact: AcpAdapterArtifact;
}

export type AcpAgentDescriptor = NativeAcpAgentDescriptor | AdapterAcpAgentDescriptor;

/**
 * The only first-class child Agents. Adapter versions and npm SRI values are
 * deliberately exact: changing either is a reviewed catalog update.
 */
export const ACP_AGENT_CATALOG: readonly AcpAgentDescriptor[] = [
  { id: "redcode", label: "Redcode", kind: "native", command: ["redcode", "acp"] },
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "adapter",
    artifact: {
      package: "@zed-industries/claude-code-acp",
      version: "0.16.2",
      integrity: "sha512-D8BJe6CCD49RtNFbZYPsfZOpQI8Z/EzhyYC9zAGMwN/HVunEtVY2sXqYl1iDSkkayzhqABfaDkDZfeqDM1T/aA==",
      entrypoint: "package/dist/index.js",
    },
  },
  {
    id: "codex",
    label: "Codex",
    kind: "adapter",
    artifact: {
      package: "@zed-industries/codex-acp",
      version: "0.16.0",
      integrity: "sha512-XKzqztT5R8Wg1BVFnk6/U4JVx5GNUaZgxpf9gP2Cw6BsknvJWh3aefcAGZQljgdMivRqczjNKYL4F6H65dc5vA==",
      entrypoint: "package/bin/codex-acp.js",
    },
  },
  {
    id: "pi",
    label: "Pi",
    kind: "adapter",
    artifact: {
      package: "pi-acp",
      version: "0.0.33",
      integrity: "sha512-vX9kY1tK14E72G4dBAx+RGCk/k7XPjTHls6dLUxA8WSkBav6B6JHuSBv3eusp50LCR/GTRsR2kIKsG0Z5jANzw==",
      entrypoint: "package/dist/index.js",
    },
  },
  { id: "opencode", label: "OpenCode", kind: "native", command: ["opencode", "acp"] },
] as const;

/** Credential-free launch projection handed to a Worker. */
export interface AcpAgentProbeResult {
  readonly protocolVersion: number;
  readonly capabilities: readonly string[];
}

export interface AcpAgentProvisionReceipt {
  readonly id: AcpAgentId;
  readonly status: "healthy" | "unavailable";
  readonly version: string;
  readonly endpoint?: AcpEndpoint;
  /** True when a rejected update left an older healthy activation selected. */
  readonly preserved?: boolean;
  readonly warning?: string;
  readonly reason?: string;
}

export class AcpAgentUnavailableError extends Error {
  constructor(
    readonly agent: AcpAgentId,
    reason: string,
  ) {
    super(
      `ACP Agent ${agent} is not available: ${reason}. ` +
      `Run redskilled ACP Agent provisioning for ${agent}; redskilled will not substitute another Agent.`,
    );
    this.name = "AcpAgentUnavailableError";
  }
}

export interface AcpAgentCatalogOptions {
  /** Host-owned catalog root, normally beneath the redskilled home. */
  readonly root?: string;
  readonly descriptors?: readonly AcpAgentDescriptor[];
  /** External network edge. It is called only by redskilled provisioning. */
  readonly fetchArtifact?: (artifact: AcpAdapterArtifact) => Promise<Uint8Array>;
  /**
   * External package-manager edge. It must unpack/install into `stage` only;
   * activation remains this module's atomic responsibility.
   */
  readonly installArtifact?: (
    bytes: Uint8Array,
    stage: string,
    descriptor: AdapterAcpAgentDescriptor,
  ) => Promise<void>;
  /** ACP initialize/session capability probe at the process boundary. */
  readonly probe: (endpoint: AcpEndpoint) => Promise<AcpAgentProbeResult>;
  readonly nodePath?: string;
}

export class AcpAgentCatalog {
  readonly #root: string;
  readonly #descriptors: readonly AcpAgentDescriptor[];
  readonly #fetchArtifact: (artifact: AcpAdapterArtifact) => Promise<Uint8Array>;
  readonly #installArtifact?: AcpAgentCatalogOptions["installArtifact"];
  readonly #probe: AcpAgentCatalogOptions["probe"];
  readonly #nodePath: string;

  constructor(options: AcpAgentCatalogOptions) {
    this.#root = options.root ?? redskilledAcpAgentCatalogRoot();
    this.#descriptors = options.descriptors ?? ACP_AGENT_CATALOG;
    this.#fetchArtifact = options.fetchArtifact ?? fetchNpmArtifact;
    this.#installArtifact = options.installArtifact;
    this.#probe = options.probe;
    this.#nodePath = options.nodePath ?? process.execPath;
    assertDescriptors(this.#descriptors);
  }

  async provisionAll(): Promise<readonly AcpAgentProvisionReceipt[]> {
    const receipts: AcpAgentProvisionReceipt[] = [];
    for (const descriptor of this.#descriptors) receipts.push(await this.provision(descriptor.id));
    return receipts;
  }

  async provision(id: AcpAgentId): Promise<AcpAgentProvisionReceipt> {
    const descriptor = this.#descriptor(id);
    if (descriptor.kind === "native") {
      const endpoint = nativeEndpoint(descriptor);
      try {
        await this.#requireHealthy(endpoint);
        return { id, status: "healthy", version: "native", endpoint };
      } catch (error) {
        return { id, status: "unavailable", version: "native", reason: messageOf(error) };
      }
    }
    return this.#provisionAdapter(descriptor);
  }

  /** Resolve exactly the requested Agent. This function never has fallback semantics. */
  async resolveForWorker(id: AcpAgentId): Promise<AcpEndpoint> {
    const descriptor = this.#descriptor(id);
    const endpoint = descriptor.kind === "native"
      ? nativeEndpoint(descriptor)
      : await this.#activeAdapterEndpoint(descriptor);
    try {
      await this.#requireHealthy(endpoint);
      return endpoint;
    } catch (error) {
      throw new AcpAgentUnavailableError(id, messageOf(error));
    }
  }

  async #provisionAdapter(descriptor: AdapterAcpAgentDescriptor): Promise<AcpAgentProvisionReceipt> {
    const activeBefore = await this.#readActiveEndpoint(descriptor);
    const desiredRelease = releaseName(descriptor.artifact);
    if (activeBefore?.release === desiredRelease) {
      try {
        await this.#requireHealthy(activeBefore.endpoint);
        return {
          id: descriptor.id,
          status: "healthy",
          version: descriptor.artifact.version,
          endpoint: activeBefore.endpoint,
        };
      } catch {
        // Re-stage the exact pin: the active bytes or their dependencies drifted.
      }
    }

    const agentRoot = join(this.#root, descriptor.id);
    const versionsRoot = join(agentRoot, "versions");
    const stage = join(agentRoot, ".staging", `${desiredRelease}-${randomUUID()}`);
    try {
      if (this.#installArtifact == null) {
        throw new Error("no host adapter installer is configured");
      }
      const bytes = await this.#fetchArtifact(descriptor.artifact);
      requireIntegrity(bytes, descriptor.artifact.integrity);
      await mkdir(stage, { recursive: true, mode: 0o700 });
      await this.#installArtifact(bytes, stage, descriptor);
      const stagedEndpoint = adapterEndpoint(descriptor, stage, this.#nodePath);
      await requireFile(join(stage, descriptor.artifact.entrypoint));
      await this.#requireHealthy(stagedEndpoint);

      await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
      const releasePath = join(versionsRoot, desiredRelease);
      await rm(releasePath, { recursive: true, force: true });
      await rename(stage, releasePath);
      await activate(agentRoot, desiredRelease);
      const endpoint = adapterEndpoint(descriptor, releasePath, this.#nodePath);
      return { id: descriptor.id, status: "healthy", version: descriptor.artifact.version, endpoint };
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      const warning = `pinned update ${descriptor.artifact.version} rejected: ${messageOf(error)}`;
      if (activeBefore != null) {
        try {
          await this.#requireHealthy(activeBefore.endpoint);
          return {
            id: descriptor.id,
            status: "healthy",
            version: versionFromRelease(activeBefore.release),
            endpoint: activeBefore.endpoint,
            preserved: true,
            warning,
          };
        } catch {
          // The prior activation exists but no longer satisfies the baseline.
        }
      }
      return {
        id: descriptor.id,
        status: "unavailable",
        version: descriptor.artifact.version,
        reason: warning,
      };
    }
  }

  async #activeAdapterEndpoint(descriptor: AdapterAcpAgentDescriptor): Promise<AcpEndpoint> {
    const active = await this.#readActiveEndpoint(descriptor);
    if (active == null) {
      throw new AcpAgentUnavailableError(descriptor.id, "no healthy pinned adapter is active");
    }
    return active.endpoint;
  }

  async #readActiveEndpoint(
    descriptor: AdapterAcpAgentDescriptor,
  ): Promise<{ readonly release: string; readonly endpoint: AcpEndpoint } | undefined> {
    const agentRoot = join(this.#root, descriptor.id);
    const release = await readFile(join(agentRoot, "active"), "utf8").catch(() => undefined);
    if (release == null) return undefined;
    const trimmed = release.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return undefined;
    const releasePath = join(agentRoot, "versions", trimmed);
    try {
      await requireFile(join(releasePath, descriptor.artifact.entrypoint));
    } catch {
      return undefined;
    }
    return { release: trimmed, endpoint: adapterEndpoint(descriptor, releasePath, this.#nodePath) };
  }

  async #requireHealthy(endpoint: AcpEndpoint): Promise<void> {
    const result = await this.#probe(endpoint);
    if (result.protocolVersion !== 1) {
      throw new Error(`ACP protocol v1 baseline unavailable (reported ${result.protocolVersion})`);
    }
    const capabilities = new Set(result.capabilities);
    const missing = ACP_AGENT_REQUIRED_CAPABILITIES.filter((capability) => !capabilities.has(capability));
    if (missing.length > 0) throw new Error(`missing ACP baseline capabilities: ${missing.join(", ")}`);
  }

  #descriptor(id: AcpAgentId): AcpAgentDescriptor {
    const descriptor = this.#descriptors.find((candidate) => candidate.id === id);
    if (descriptor == null) throw new AcpAgentUnavailableError(id, "it is not configured in the host catalog");
    return descriptor;
  }
}

/** Canonical host-owned catalog location; no repository path participates. */
export function redskilledAcpAgentCatalogRoot(homeDir: string = homedir()): string {
  return join(redskilledHomeDir(homeDir), "acp-agents");
}

function nativeEndpoint(descriptor: NativeAcpAgentDescriptor): AcpEndpoint {
  return {
    agent: descriptor.id,
    transport: "stdio",
    command: descriptor.command[0],
    args: descriptor.command.slice(1),
  };
}

function adapterEndpoint(
  descriptor: AdapterAcpAgentDescriptor,
  releasePath: string,
  nodePath: string,
): AcpEndpoint {
  return {
    agent: descriptor.id,
    transport: "stdio",
    command: nodePath,
    args: [join(releasePath, descriptor.artifact.entrypoint)],
  };
}

function releaseName(artifact: AcpAdapterArtifact): string {
  const pin = createHash("sha256").update(artifact.integrity).digest("hex").slice(0, 12);
  return `${artifact.version}--${pin}`;
}

function versionFromRelease(release: string): string {
  return release.split("--", 1)[0] ?? release;
}

function requireIntegrity(bytes: Uint8Array, integrity: string): void {
  const [algorithm, expectedText, extra] = integrity.split("-");
  if (algorithm !== "sha512" || expectedText == null || expectedText.length === 0 || extra != null) {
    throw new Error(`unsupported adapter integrity ${integrity}`);
  }
  const actual = createHash("sha512").update(bytes).digest();
  const expected = Buffer.from(expectedText, "base64");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("adapter artifact integrity mismatch");
  }
}

async function requireFile(path: string): Promise<void> {
  const facts = await stat(path);
  if (!facts.isFile()) throw new Error(`adapter entrypoint is not a file: ${basename(path)}`);
}

/** Atomic single-value pointer: structured activation metadata is not written as JSON. */
async function activate(agentRoot: string, release: string): Promise<void> {
  await mkdir(agentRoot, { recursive: true, mode: 0o700 });
  const target = join(agentRoot, "active");
  const temporary = join(dirname(target), `.active-${randomUUID()}`);
  await writeFile(temporary, `${release}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fetchNpmArtifact(artifact: AcpAdapterArtifact): Promise<Uint8Array> {
  const encodedPackage = encodeURIComponent(artifact.package).replace("%2F", "%2f");
  const packageBase = artifact.package.split("/").at(-1);
  const url = `https://registry.npmjs.org/${encodedPackage}/-/${packageBase}-${artifact.version}.tgz`;
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`adapter registry returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function assertDescriptors(descriptors: readonly AcpAgentDescriptor[]): void {
  const seen = new Set<AcpAgentId>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) throw new Error(`duplicate ACP Agent descriptor: ${descriptor.id}`);
    seen.add(descriptor.id);
    if (descriptor.kind === "adapter") {
      if (!/^\d+\.\d+\.\d+$/.test(descriptor.artifact.version)) {
        throw new Error(`ACP adapter ${descriptor.id} must use an exact semantic version`);
      }
      if (descriptor.artifact.entrypoint.startsWith("/") || descriptor.artifact.entrypoint.includes("..")) {
        throw new Error(`ACP adapter ${descriptor.id} has an unsafe entrypoint`);
      }
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
