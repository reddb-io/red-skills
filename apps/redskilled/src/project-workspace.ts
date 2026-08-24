/**
 * Resolve a client checkout to daemon-owned Project state.
 *
 * A checkout path is evidence, never an execution root. GitHub's numeric
 * repository id is stable across clones, moves, and repository renames, so it
 * is the Project key. The checkout only seeds the canonical workspace from its
 * committed HEAD; uncommitted and untracked editor state cannot cross that
 * clone boundary.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  repoSlugFromRemoteUrl,
  resolveProjectIdentity,
} from "@reddb-io/shared/project-identity.js";

const GIT_TIMEOUT_MS = 10_000;
const GITHUB_TIMEOUT_MS = 5_000;

export interface AcpProjectIdentity {
  readonly projectId: string;
  readonly projectLabel: string;
  readonly checkoutRoot: string;
  /** The checkout's canonical remote, when it has one — the fetch source for fresh forks (#4188). */
  readonly remoteUrl?: string;
}

export interface AcpProjectWorkspace extends AcpProjectIdentity {
  readonly workspacePath: string;
  /** Daemon-selected credential binding; absent for checkout-derived Projects. */
  readonly credentialProfile?: string;
}

export interface ResolveAcpProjectIdentityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  /** The daemon's own credential; env vars remain the fallback. */
  readonly resolveToken?: () => string | null | Promise<string | null>;
  /**
   * Durable slug → GitHub identity answers. A hit is authoritative and costs
   * no network: a GitHub numeric id is immutable across renames, and identity
   * deciding differently per bind is exactly the split this closes.
   */
  readonly identityCache?: {
    read(slug: string): Promise<{ github_id: string; full_name: string } | undefined>;
    remember(entry: { slug: string; githubId: string; fullName: string }): Promise<void>;
  };
  /**
   * Told when a GitHub-remoted checkout could not resolve its `github:<id>`
   * and fell back to `remote:<slug>` — the silent demotion that used to split
   * one repository into two project identities.
   */
  readonly onIdentityDemotion?: (slug: string, reason: string) => void;
}

/** Resolve identity without creating Project state, so authority can be checked first. */
export async function resolveAcpProjectIdentity(
  cwd: string,
  options: ResolveAcpProjectIdentityOptions = {},
): Promise<AcpProjectIdentity> {
  const checkoutRoot = await gitOutput(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;
  const gitCommonDir = await gitOutput(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const remoteUrl = await gitOutput(cwd, ["remote", "get-url", "origin"]);
  const remoteSlug = repoSlugFromRemoteUrl(remoteUrl);
  // The cache answers first, with no network: one successful resolution is
  // authoritative forever (GitHub ids survive renames), so a rate-limited or
  // offline bind can no longer demote a known repository to a second identity.
  const cached = remoteSlug == null
    ? undefined
    : await options.identityCache?.read(remoteSlug).catch(() => undefined);
  if (cached != null) {
    return {
      projectId: `github:${cached.github_id}`,
      projectLabel: cached.full_name,
      checkoutRoot,
      ...(remoteUrl == null ? {} : { remoteUrl }),
    };
  }
  let demotionReason = "the GitHub repository read answered without an identity";
  const github = remoteSlug == null
    ? undefined
    : await readGithubRepository(remoteSlug, remoteUrl, options).catch((error) => {
        demotionReason = error instanceof Error ? error.message : String(error);
        return undefined;
      });
  if (github != null) {
    await options.identityCache?.remember({
      slug: remoteSlug as string,
      githubId: github.id,
      fullName: github.fullName,
    }).catch(() => undefined);
    return {
      projectId: `github:${github.id}`,
      projectLabel: github.fullName,
      checkoutRoot,
      ...(remoteUrl == null ? {} : { remoteUrl }),
    };
  }
  if (remoteSlug != null) options.onIdentityDemotion?.(remoteSlug, demotionReason);

  // Non-GitHub directories remain usable by generic ACP clients. This fallback
  // is deliberately named as local/remote evidence; it never masquerades as an
  // immutable GitHub identity.
  const fallback = resolveProjectIdentity({
    checkoutPath: checkoutRoot,
    ...(gitCommonDir == null ? {} : { gitCommonDir }),
    ...(remoteUrl == null ? {} : { remoteUrl }),
  });
  return {
    projectId: remoteSlug == null ? `local:${fallback.hash}` : `remote:${remoteSlug}`,
    projectLabel: fallback.name,
    checkoutRoot,
    ...(remoteUrl == null ? {} : { remoteUrl }),
  };
}

/** Materialize (or reuse) the one clean execution workspace for a Project. */
export async function ensureAcpProjectWorkspace(
  identity: AcpProjectIdentity,
  workspaceRoot: string,
): Promise<AcpProjectWorkspace> {
  const projectDir = join(workspaceRoot, projectDirectoryName(identity.projectId));
  const workspacePath = join(projectDir, "workspace");
  if (await exists(workspacePath)) return { ...identity, workspacePath };

  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  if (await gitOutput(identity.checkoutRoot, ["rev-parse", "--is-inside-work-tree"]) === "true") {
    const staging = await mkdtemp(join(projectDir, "seed-"));
    const candidate = join(staging, "workspace");
    try {
      await gitOutput(projectDir, [
        "clone",
        "--no-hardlinks",
        "--quiet",
        "--",
        identity.checkoutRoot,
        candidate,
      ], true);
      try {
        await rename(candidate, workspacePath);
      } catch (error) {
        if (!(await exists(workspacePath))) throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    await mkdir(workspacePath, { recursive: true, mode: 0o700 });
  }
  return { ...identity, workspacePath };
}

/** Materialize a clean Project directly from its canonical remote. */
export async function ensureRemoteAcpProjectWorkspace(
  identity: AcpProjectIdentity,
  workspaceRoot: string,
  credential: string,
): Promise<AcpProjectWorkspace> {
  const projectDir = join(workspaceRoot, projectDirectoryName(identity.projectId));
  const workspacePath = join(projectDir, "workspace");
  if (await exists(workspacePath)) return { ...identity, checkoutRoot: workspacePath, workspacePath };
  if (identity.remoteUrl == null) throw new Error("a remote Project requires one canonical clone URL");

  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(projectDir, "remote-"));
  const candidate = join(staging, "workspace");
  const authorization = Buffer.from(`x-access-token:${credential}`, "utf8").toString("base64");
  try {
    await gitOutput(projectDir, ["clone", "--quiet", "--", identity.remoteUrl, candidate], true, {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
      GIT_TERMINAL_PROMPT: "0",
    });
    try {
      await rename(candidate, workspacePath);
    } catch (error) {
      if (!(await exists(workspacePath))) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { ...identity, checkoutRoot: workspacePath, workspacePath };
}

interface GithubRepositoryAnswer {
  readonly id: string;
  readonly fullName: string;
}

async function readGithubRepository(
  slug: string,
  remoteUrl: string | undefined,
  options: ResolveAcpProjectIdentityOptions,
): Promise<GithubRepositoryAnswer | undefined> {
  const env = options.env ?? process.env;
  const configuredOrigin = env.GITHUB_API_URL?.trim();
  const isGithubRemote = /(^|[.@/:])github\.com(?=[:/])/i.test(remoteUrl ?? "");
  // The daemon's own credential first: an unauthenticated read runs against a
  // 60/hour/IP budget, and exhausting it mid-day is what flipped identity per
  // bind. Env vars stay as the fallback for embeddings without a gateway.
  const resolved = options.resolveToken == null ? null : await options.resolveToken();
  const token = (resolved ?? env.REDSKILLED_HOST_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  if (!configuredOrigin && !isGithubRemote && token === "") return undefined;

  const origin = (configuredOrigin || "https://api.github.com").replace(/\/+$/, "");
  const route = slug.split("/").map(encodeURIComponent).join("/");
  const response = await (options.fetchImpl ?? fetch)(`${origin}/repos/${route}`, {
    headers: {
      accept: "application/vnd.github+json",
      ...(token === "" ? {} : { authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { id?: unknown; full_name?: unknown };
  if ((typeof body.id !== "number" && typeof body.id !== "string") || typeof body.full_name !== "string") {
    return undefined;
  }
  const id = String(body.id).trim();
  const fullName = body.full_name.trim();
  return id === "" || fullName === "" ? undefined : { id, fullName };
}

/**
 * The directory name a Project key gets on disk.
 *
 * Exported because the workspace root is no longer the only per-Project
 * directory the daemon places: `~/.red/memory/<project-id>` is named the same
 * way (ADR 0152), and two hand-kept spellings of one key would put a Project's
 * memory beside its workspace under a different name.
 */
export function projectDirectoryName(projectId: string): string {
  const readable = projectId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 8);
  return `${readable}-${hash}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(
  cwd: string,
  args: readonly string[],
  required = false,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env,
    }, (error, stdout) => {
      if (error != null) {
        if (required) reject(error);
        else resolve(undefined);
        return;
      }
      const value = stdout.trim();
      resolve(value === "" ? undefined : value);
    });
  });
}
