import { spawn } from "node:child_process";
import type { StoredBrainArtifact, StoredBrainConnection } from "./schema.js";

export const AUTO_LINK_CONNECTION_KINDS = ["supports", "contradicts", "related_to"] as const;

export type AutoLinkConnectionKind = (typeof AUTO_LINK_CONNECTION_KINDS)[number];

export interface BrainAutoLinkArtifact {
  rid: number;
  id: string;
  title: string;
  kind: string;
  content: string;
  tags: string[];
}

export interface BrainAutoLinkCandidate {
  artifact: BrainAutoLinkArtifact;
  score: number;
  excerpt: string;
}

export interface BrainAutoLinkRequest {
  newArtifact: BrainAutoLinkArtifact;
  candidates: BrainAutoLinkCandidate[];
  think: {
    query: string;
    answer: string;
  };
  allowedKinds: readonly AutoLinkConnectionKind[];
}

export interface BrainAutoLinkProposal {
  from: number | string;
  to: number | string;
  kind: AutoLinkConnectionKind;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface BrainAutoLinkProvider {
  deriveConnections(request: BrainAutoLinkRequest): Promise<BrainAutoLinkProposal[]>;
}

export interface AppliedBrainAutoLink {
  proposal: BrainAutoLinkProposal;
  connection: StoredBrainConnection;
}

export function artifactToAutoLinkArtifact(artifact: StoredBrainArtifact): BrainAutoLinkArtifact {
  return {
    rid: artifact.rid,
    id: artifact.properties.id,
    title: artifact.properties.title,
    kind: artifact.kind,
    content: artifact.properties.content,
    tags: artifact.properties.tags,
  };
}

export function isAutoLinkConnectionKind(value: unknown): value is AutoLinkConnectionKind {
  return typeof value === "string" && (AUTO_LINK_CONNECTION_KINDS as readonly string[]).includes(value);
}

export function isDerivedArtifact(artifact: StoredBrainArtifact): boolean {
  return artifact.properties.metadata?.derived === true || typeof artifact.properties.metadata?.derived_kind === "string";
}

export function autoLinkThinkQuery(artifact: StoredBrainArtifact): string {
  return [
    artifact.properties.title,
    artifact.kind,
    ...artifact.properties.tags,
    artifact.properties.content,
  ].join("\n");
}

export interface AfkHeadlessAutoLinkProviderOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Command-backed LLM port for Brain autolinking. The command is expected to be
 * an AFK/headless runner wrapper, not a direct model SDK call. It receives a
 * JSON {@link BrainAutoLinkRequest} on stdin and must print either a JSON array
 * of proposals or `{ "connections": [...] }` on stdout.
 */
export function createAfkHeadlessAutoLinkProvider(
  options: AfkHeadlessAutoLinkProviderOptions,
): BrainAutoLinkProvider {
  return {
    deriveConnections(request) {
      return runAfkHeadlessAutoLinkProvider(options, request);
    },
  };
}

export function createConfiguredAfkHeadlessAutoLinkProvider(
  env: NodeJS.ProcessEnv = process.env,
): BrainAutoLinkProvider | undefined {
  const command = env.RED_BRAIN_AUTOLINK_AFK_COMMAND ?? env.RED_BRAIN_AUTOLINK_HEADLESS_COMMAND;
  if (!command) return undefined;
  return createAfkHeadlessAutoLinkProvider({
    command,
    args: parseHeadlessArgs(env.RED_BRAIN_AUTOLINK_AFK_ARGS ?? env.RED_BRAIN_AUTOLINK_HEADLESS_ARGS),
    cwd: env.RED_BRAIN_AUTOLINK_AFK_CWD ?? env.RED_BRAIN_AUTOLINK_HEADLESS_CWD,
    env,
    timeoutMs: parsePositiveInteger(env.RED_BRAIN_AUTOLINK_AFK_TIMEOUT_MS) ?? 60_000,
  });
}

export function parseAutoLinkProviderResponse(text: string): BrainAutoLinkProposal[] {
  const parsed = JSON.parse(extractJsonPayload(text)) as unknown;
  const proposals = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.connections)
      ? parsed.connections
      : [];
  return proposals.filter(isProposal).map((proposal) => ({
    from: proposal.from,
    to: proposal.to,
    kind: proposal.kind,
    reason: typeof proposal.reason === "string" ? proposal.reason : undefined,
    metadata: isRecord(proposal.metadata) ? proposal.metadata : undefined,
  }));
}

async function runAfkHeadlessAutoLinkProvider(
  options: AfkHeadlessAutoLinkProviderOptions,
  request: BrainAutoLinkRequest,
): Promise<BrainAutoLinkProposal[]> {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timeout: NodeJS.Timeout | undefined;

  const done = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("close", (code) => resolve(code ?? 0));
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Brain autolink AFK headless provider timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }
  });

  child.stdin.end(JSON.stringify(request));

  try {
    const code = await done;
    if (code !== 0) {
      const message = Buffer.concat(stderr).toString("utf8").trim();
      throw new Error(`Brain autolink AFK headless provider exited ${code}${message ? `: ${message}` : ""}`);
    }
    return parseAutoLinkProviderResponse(Buffer.concat(stdout).toString("utf8"));
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function parseHeadlessArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("RED_BRAIN_AUTOLINK_AFK_ARGS must be a JSON array of strings");
  }
  return parsed;
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fence?.[1] ?? trimmed).trim();
}

function isProposal(value: unknown): value is BrainAutoLinkProposal {
  return (
    isRecord(value) &&
    (typeof value.from === "number" || typeof value.from === "string") &&
    (typeof value.to === "number" || typeof value.to === "string") &&
    isAutoLinkConnectionKind(value.kind)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
