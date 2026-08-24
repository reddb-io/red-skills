// github-custody-tender — the boot-time (and slow re-tender) resume of durable
// merge-custody obligations.
//
// **A durable record whose driver died is a promise nobody keeps.** The
// custodian's tick timers live in memory and are re-armed only by `register`,
// whose only callers are a connection's `handoff`/`status` — so after a daemon
// restart every active custody record sat inert, publishing
// `next_action: "repair-custodian"` with its own ready-made repair that no
// process ever executed. The daemon restarts on every self-upgrade, which made
// this the steady state, not an edge: nine PRs once waited thirteen hours on a
// two-minute threshold for a client to happen to ask.
//
// The tender resumes obligations from the snapshot the custodian itself
// persists: each active record already carries its whole project authority and
// its credential profile, so one `mergeCustodyStatus()` per distinct
// project/credential pair re-registers the execution and re-arms every tick.
// A record whose credential cannot be resolved is reported, never retried hot
// — the interval pass picks it up when a credential appears.
import { readFile } from "node:fs/promises";

import { decode } from "@reddb-io/toon";
import type { RedskilledGithubManagedProjectReader } from "./github-gateway.js";
import { credentialForAcpProject } from "./github-project-credential.js";
import type { RedskilledGithubGatewayRegistration } from "./github-project-credential.js";

export interface GithubCustodyTenderReport {
  /** Distinct project/credential executions re-registered this pass. */
  readonly resumed: number;
  /** Project ids whose credential profile resolved to nothing, one entry each. */
  readonly unresolved: readonly string[];
}

export interface StartGithubCustodyTenderOptions {
  /** The custodian's own durable snapshot; the tender never writes it. */
  readonly custodyPath: string;
  readonly registration: RedskilledGithubGatewayRegistration;
  /** How often obligations are re-tendered; 5 minutes when unstated. */
  readonly intervalMs?: number;
  readonly onReport?: (report: GithubCustodyTenderReport) => void;
}

interface TenderableRecord {
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly credential_profile: string;
}

/** One resume pass over the snapshot. Never rejects; absence is an empty pass. */
export async function tendGithubCustody(
  options: Pick<StartGithubCustodyTenderOptions, "custodyPath" | "registration">,
): Promise<GithubCustodyTenderReport> {
  const records = await readActiveCustodyRecords(options.custodyPath);
  const unresolved: string[] = [];
  let resumed = 0;
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.project_id}\0${record.credential_profile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const selection = await credentialForAcpProject(options.registration, {
        projectId: record.project_id,
        projectLabel: record.project_label,
        workspacePath: record.workspace_path,
        credentialProfile: record.credential_profile,
      });
      if (selection == null) {
        unresolved.push(record.project_id);
        continue;
      }
      // `mergeCustodyStatus` runs the custodian's own `register` first, which
      // re-arms every non-terminal record this project holds — the record's
      // published repair, executed through the same authority that made it.
      const reader = options.registration.gateway.forProject({
        projectId: record.project_id,
        projectLabel: record.project_label,
        workspacePath: record.workspace_path,
        credentialProfile: selection.profile,
      }, selection.credential) as Partial<RedskilledGithubManagedProjectReader>;
      // A gateway without the managed surface holds no custodian to re-arm.
      if (typeof reader.mergeCustodyStatus !== "function") {
        unresolved.push(record.project_id);
        continue;
      }
      await reader.mergeCustodyStatus();
      resumed += 1;
    } catch {
      unresolved.push(record.project_id);
    }
  }
  return { resumed, unresolved };
}

/**
 * Resume now, then keep re-tendering on an interval.
 *
 * The interval is deliberately slow and `unref`'d: the first pass does the
 * repair; later passes exist so a credential that appears after boot still
 * revives the records it was missing for.
 */
export function startGithubCustodyTender(
  options: StartGithubCustodyTenderOptions,
): { stop(): void } {
  const intervalMs = options.intervalMs ?? 300_000;
  const pass = (): void => {
    void tendGithubCustody(options)
      .then((report) => options.onReport?.(report))
      .catch(() => undefined);
  };
  pass();
  const timer = setInterval(pass, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function readActiveCustodyRecords(path: string): Promise<TenderableRecord[]> {
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
  const snapshot = parsed as { records?: unknown };
  if (!Array.isArray(snapshot?.records)) return [];
  return snapshot.records.filter((value): value is TenderableRecord & { state?: string } => {
    const record = value as Record<string, unknown> | null;
    return record != null && typeof record === "object" &&
      typeof record.project_id === "string" && typeof record.project_label === "string" &&
      typeof record.workspace_path === "string" && typeof record.credential_profile === "string" &&
      record.state !== "terminal";
  });
}
