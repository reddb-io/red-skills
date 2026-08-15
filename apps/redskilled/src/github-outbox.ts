import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import {
  RedskilledGithubAuthorityError,
  type RedskilledGithubCredential,
  type RedskilledGithubProjectAuthority,
  type RedskilledGithubWrite,
  type RedskilledGithubWriteAnswer,
  type RedskilledGithubWriteRequest,
  type RedskilledGithubWriteUpstream,
} from "./github-gateway.js";

interface GithubOutboxEntry {
  readonly idempotency_key: string;
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly credential_profile: string;
  readonly write: RedskilledGithubWrite;
  readonly queued_at: string;
  state: "pending" | "published";
  published_at?: string;
  value?: unknown;
}

interface GithubOutboxSnapshot {
  readonly version: 1;
  readonly entries: GithubOutboxEntry[];
}

export interface GithubOutbox {
  publish(
    project: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
    request: RedskilledGithubWriteRequest,
  ): Promise<RedskilledGithubWriteAnswer>;
  resume(
    project: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
  ): Promise<readonly RedskilledGithubWriteAnswer[]>;
}

/**
 * One durable queue owns the write order. The credential is deliberately an
 * execution argument, never an outbox field, so a replacement daemon can retry
 * with freshly resolved secret material without ever exposing it to a Worker.
 */
export function createGithubOutbox(
  path: string,
  upstream: RedskilledGithubWriteUpstream,
  clock: () => string,
): GithubOutbox {
  let snapshot: GithubOutboxSnapshot | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  const load = async (): Promise<GithubOutboxSnapshot> => {
    if (snapshot != null) return snapshot;
    try {
      const decoded = decode((await readFile(path, "utf8")).trim());
      snapshot = parseOutboxSnapshot(decoded);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      snapshot = { version: 1, entries: [] };
    }
    return snapshot;
  };

  const persist = async (value: GithubOutboxSnapshot): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${encode(value as unknown as JsonValue)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  };

  const execute = async (
    project: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
    request: RedskilledGithubWriteRequest,
  ): Promise<RedskilledGithubWriteAnswer> => {
    const current = await load();
    let entry = current.entries.find((candidate) =>
      candidate.project_id === project.projectId &&
      candidate.credential_profile === project.credentialProfile &&
      candidate.idempotency_key === request.idempotency_key
    );
    if (entry != null && JSON.stringify(entry.write) !== JSON.stringify(request.write)) {
      throw new RedskilledGithubAuthorityError("a GitHub idempotency key cannot name two different writes");
    }
    if (entry?.state === "published") return outboxAnswer(entry);
    if (entry == null) {
      entry = {
        idempotency_key: request.idempotency_key,
        project_id: project.projectId,
        project_label: project.projectLabel,
        workspace_path: project.workspacePath,
        credential_profile: project.credentialProfile,
        write: request.write,
        queued_at: clock(),
        state: "pending",
      };
      current.entries.push(entry);
      await persist(current);
    }

    const value = await upstream({
      project,
      credential,
      idempotencyKey: entry.idempotency_key,
      write: entry.write,
    });
    entry.value = value ?? null;
    entry.published_at = clock();
    entry.state = "published";
    await persist(current);
    return outboxAnswer(entry);
  };

  return {
    publish(project, credential, request) {
      return serialized(() => execute(project, credential, request));
    },
    async resume(project, credential) {
      const pending = await serialized(async () => {
        const current = await load();
        return current.entries
          .filter((entry) =>
            entry.state === "pending" &&
            entry.project_id === project.projectId &&
            entry.credential_profile === project.credentialProfile
          )
          .map((entry) => ({ idempotency_key: entry.idempotency_key, write: entry.write }));
      });
      const answers: RedskilledGithubWriteAnswer[] = [];
      for (const request of pending) {
        answers.push(await serialized(() => execute(project, credential, request)));
      }
      return answers;
    },
  };
}

function outboxAnswer(entry: GithubOutboxEntry): RedskilledGithubWriteAnswer {
  if (entry.state !== "published" || entry.published_at == null) {
    throw new Error("a pending GitHub outbox entry has no publication receipt");
  }
  return {
    version: 1,
    project_id: entry.project_id,
    credential_profile: entry.credential_profile,
    idempotency_key: entry.idempotency_key,
    state: "published",
    queued_at: entry.queued_at,
    published_at: entry.published_at,
    value: entry.value ?? null,
  };
}

function parseOutboxSnapshot(value: unknown): GithubOutboxSnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("redskilled GitHub outbox is not a snapshot");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.entries)) {
    throw new Error("redskilled GitHub outbox has an unsupported version");
  }
  const entries = record.entries.map(parseOutboxEntry);
  return { version: 1, entries };
}

function parseOutboxEntry(value: unknown): GithubOutboxEntry {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("redskilled GitHub outbox contains an invalid entry");
  }
  const entry = value as Record<string, unknown>;
  const project = validateStoredAuthority({
    projectId: scalar(entry.project_id),
    projectLabel: scalar(entry.project_label),
    workspacePath: scalar(entry.workspace_path),
    credentialProfile: scalar(entry.credential_profile),
  });
  const request = validateWriteRequest({
    idempotency_key: scalar(entry.idempotency_key),
    write: entry.write as RedskilledGithubWrite,
  });
  if (entry.state !== "pending" && entry.state !== "published") {
    throw new Error("redskilled GitHub outbox contains an invalid state");
  }
  const queuedAt = scalar(entry.queued_at);
  const publishedAt = entry.published_at == null ? undefined : scalar(entry.published_at);
  if (entry.state === "published" && publishedAt == null) {
    throw new Error("redskilled GitHub outbox contains an incomplete receipt");
  }
  return {
    idempotency_key: request.idempotency_key,
    project_id: project.projectId,
    project_label: project.projectLabel,
    workspace_path: project.workspacePath,
    credential_profile: project.credentialProfile,
    write: request.write,
    queued_at: queuedAt,
    state: entry.state,
    ...(publishedAt == null ? {} : { published_at: publishedAt }),
    ...(entry.value === undefined ? {} : { value: entry.value }),
  };
}

export function validateWriteRequest(request: RedskilledGithubWriteRequest): RedskilledGithubWriteRequest {
  if (request == null || typeof request !== "object" || Array.isArray(request)) {
    return refuse("a GitHub write must be an object");
  }
  requireOnlyKeys(request, ["idempotency_key", "write"]);
  const key = typeof request.idempotency_key === "string" ? request.idempotency_key.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    return refuse("a GitHub write needs one publishable idempotency key");
  }
  const write = validateWrite(request.write);
  return { idempotency_key: key, write };
}

function validateWrite(write: RedskilledGithubWrite): RedskilledGithubWrite {
  if (write == null || typeof write !== "object" || Array.isArray(write)) {
    return refuse("a GitHub write needs one mutation object");
  }
  if (write.kind === "repository-push") {
    requireOnlyKeys(write, ["kind", "ref", "sha"]);
    const ref = validateBranchRef(write.ref, "push");
    const sha = typeof write.sha === "string" ? write.sha.trim() : "";
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) return refuse("a repository push needs one commit SHA");
    return { kind: "repository-push", ref, sha };
  }
  if (write.kind === "pull-request") {
    requireOnlyKeys(write, ["kind", "head", "base", "title", "body"]);
    const head = validateBranchName(write.head, "pull-request head");
    const base = validateBranchName(write.base, "pull-request base");
    const title = nonEmpty(write.title, "a pull request needs a title");
    const body = typeof write.body === "string" ? write.body : refuse("a pull request needs a body");
    return { kind: "pull-request", head, base, title, body };
  }
  if (write.kind === "issue-publication") {
    requireOnlyKeys(write, ["kind", "issue", "title", "body"]);
    const body = typeof write.body === "string" ? write.body : refuse("an Issue publication needs a body");
    if (write.issue != null) {
      if (!Number.isSafeInteger(write.issue) || write.issue <= 0 || write.title != null) {
        return refuse("an Issue comment needs one positive Issue number and no title");
      }
      return { kind: "issue-publication", issue: write.issue, body };
    }
    return {
      kind: "issue-publication",
      title: nonEmpty(write.title, "a new Issue publication needs a title"),
      body,
    };
  }
  return refuse("Project authority permits only repository push, pull request, and Issue publication writes");
}

function validateBranchRef(value: unknown, label: string): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref.startsWith("refs/heads/")) return refuse(`a ${label} may name only one branch ref`);
  validateBranchName(ref.slice("refs/heads/".length), label);
  return ref;
}

function validateBranchName(value: unknown, label: string): string {
  const branch = typeof value === "string" ? value.trim() : "";
  if (branch === "" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(branch) ||
    branch.includes("..") || branch.includes("//") || branch.endsWith(".") ||
    branch.endsWith("/") || branch.includes("@{")) {
    return refuse(`a ${label} may name only one ordinary branch`);
  }
  return branch;
}

function validateStoredAuthority(
  authority: RedskilledGithubProjectAuthority,
): RedskilledGithubProjectAuthority {
  const fields = [authority.projectId, authority.projectLabel, authority.workspacePath, authority.credentialProfile];
  if (fields.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new RedskilledGithubAuthorityError("a GitHub reader needs one resolved Project and credential profile");
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(authority.projectLabel)) {
    throw new RedskilledGithubAuthorityError("the resolved Project has no canonical GitHub repository identity");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(authority.credentialProfile)) {
    throw new RedskilledGithubAuthorityError("the daemon-owned credential profile name is not publishable");
  }
  return { ...authority };
}

function nonEmpty(value: unknown, message: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? refuse(message) : text;
}

function scalar(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("redskilled GitHub outbox contains an invalid scalar");
  }
  return value;
}

function refuse(message: string): never {
  throw new RedskilledGithubAuthorityError(message);
}

function requireOnlyKeys(value: object, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra != null) {
    refuse("a Project GitHub read cannot carry Project, credential, remote, or host authority fields");
  }
}
