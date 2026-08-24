// project-identity-store — the durable answer to "which GitHub repository is
// this remote slug?".
//
// **Identity must not depend on a live network call.** Project identity was
// decided per bind by an (often unauthenticated) GitHub read: past the rate
// limit, offline, or against a private repository the resolution silently
// demoted `github:<id>` to `remote:<slug>` — and every store keyed by project
// id (control state, workspaces, memory roots) split in two. A GitHub numeric
// id is immutable across renames, so one successful resolution is
// authoritative forever; this store files it beside the other host-state
// snapshots and answers every later bind without the network.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { decode, encode, type JsonValue } from "@reddb-io/toon";

export interface ProjectIdentityRecord {
  /** The normalized `owner/repo` slug the checkout's remote names. */
  readonly slug: string;
  readonly github_id: string;
  readonly full_name: string;
  readonly first_resolved_at: string;
  readonly last_confirmed_at: string;
}

export interface ProjectIdentityStore {
  read(slug: string): Promise<ProjectIdentityRecord | undefined>;
  remember(entry: { slug: string; githubId: string; fullName: string }): Promise<void>;
}

/** The snapshot lives beside the other durable host-state files. */
export function projectIdentityStorePath(registrationIntentPath: string): string {
  return join(dirname(registrationIntentPath), "redskilled.project-identities.toon");
}

export function createProjectIdentityStore(
  path: string,
  clock: () => string = () => new Date().toISOString(),
): ProjectIdentityStore {
  let tail: Promise<unknown> = Promise.resolve();
  const load = async (): Promise<ProjectIdentityRecord[]> => {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = decode(raw.trim());
    } catch {
      return [];
    }
    const snapshot = parsed as { identities?: unknown };
    if (!Array.isArray(snapshot?.identities)) return [];
    return snapshot.identities.filter(isProjectIdentityRecord);
  };
  return {
    async read(slug) {
      const normalized = normalizeSlug(slug);
      return (await load()).find((record) => record.slug === normalized);
    },
    async remember(entry) {
      const write = tail.then(async () => {
        const normalized = normalizeSlug(entry.slug);
        const now = clock();
        const held = await load();
        const existing = held.find((record) => record.slug === normalized);
        const next: ProjectIdentityRecord = {
          slug: normalized,
          github_id: entry.githubId,
          full_name: entry.fullName,
          first_resolved_at: existing?.first_resolved_at ?? now,
          last_confirmed_at: now,
        };
        const records = [...held.filter((record) => record.slug !== normalized), next]
          .sort((left, right) => left.slug.localeCompare(right.slug));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(
            temporary,
            `${encode({ version: 1, identities: records } as unknown as JsonValue)}\n`,
            { mode: 0o600 },
          );
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      });
      tail = write.catch(() => undefined);
      await write;
    },
  };
}

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function isProjectIdentityRecord(value: unknown): value is ProjectIdentityRecord {
  const record = value as Record<string, unknown> | null;
  return record != null && typeof record === "object" &&
    typeof record.slug === "string" && typeof record.github_id === "string" &&
    typeof record.full_name === "string" && typeof record.first_resolved_at === "string" &&
    typeof record.last_confirmed_at === "string";
}
