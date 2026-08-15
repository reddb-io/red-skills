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
}

export interface AcpProjectWorkspace extends AcpProjectIdentity {
  readonly workspacePath: string;
}

export interface ResolveAcpProjectIdentityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
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
  const github = remoteSlug == null
    ? undefined
    : await readGithubRepository(remoteSlug, remoteUrl, options).catch(() => undefined);
  if (github != null) {
    return {
      projectId: `github:${github.id}`,
      projectLabel: github.fullName,
      checkoutRoot,
    };
  }

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
  };
}

/** Materialize (or reuse) the one clean execution workspace for a Project. */
export async function ensureAcpProjectWorkspace(
  identity: AcpProjectIdentity,
  workspaceRoot: string,
): Promise<AcpProjectWorkspace> {
  const projectDir = join(workspaceRoot, projectDirectory(identity.projectId));
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
  const token = (env.REDSKILLED_HOST_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
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

function projectDirectory(projectId: string): string {
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

async function gitOutput(cwd: string, args: readonly string[], required = false): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
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
