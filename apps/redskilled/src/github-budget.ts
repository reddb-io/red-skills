import type { GithubLimitFact } from "@reddb-io/github";
import type {
  RedskilledGithubGateway,
  RedskilledGithubManagedGateway,
  RedskilledGithubProjectAuthority,
  RedskilledGithubRead,
} from "./github-gateway.js";

export interface RedskilledGithubBudgetFacts {
  readonly pool: string;
  readonly remaining: number | null;
  readonly reset_at: string | null;
  readonly limit?: number | null;
}

export type RedskilledGithubBudgetPool = "rest" | "graphql" | "search";
export type RedskilledGithubBudgetEvidenceState =
  | "authoritative"
  | "cached"
  | "unavailable"
  | "unknown"
  | "backpressured";

export interface RedskilledGithubBudgetEvidence {
  readonly state: RedskilledGithubBudgetEvidenceState;
  readonly authority: "github" | "redskilled-cache" | "redskilled-gateway";
  readonly observed_at: string | null;
  readonly age_ms: number | null;
  readonly fresh: boolean;
}

export interface RedskilledGithubBudgetPresentation {
  readonly warning: "normal" | "warning" | "critical" | "unknown";
  readonly density: "compact" | "expanded";
}

export interface RedskilledGithubPoolBudgetProjection {
  readonly pool: RedskilledGithubBudgetPool;
  readonly remaining: number | null;
  readonly used: number | null;
  readonly limit: number | null;
  readonly reset_at: string | null;
  readonly retry_at: string | null;
  readonly evidence: RedskilledGithubBudgetEvidence;
  readonly active_backpressure: null | {
    readonly kind: GithubLimitFact["kind"];
    readonly pool: GithubLimitFact["pool"];
    readonly retry_at: string;
    readonly evidence: GithubLimitFact["evidence"];
  };
  readonly presentation: RedskilledGithubBudgetPresentation;
}

export interface RedskilledGithubProjectBudgetProjection {
  readonly version: 1;
  readonly scope: "project";
  readonly project_id: string;
  readonly project_label: string;
  readonly credential_profile: string;
  readonly pools: readonly RedskilledGithubPoolBudgetProjection[];
}

export interface RedskilledGithubProfileBudgetProjection {
  readonly credential_profile: string;
  readonly project_ids: readonly string[];
  readonly project_labels: readonly string[];
  readonly pools: readonly RedskilledGithubPoolBudgetProjection[];
}

export interface RedskilledGithubHostBudgetProjection {
  readonly version: 1;
  readonly scope: "host-administration";
  readonly profiles: readonly RedskilledGithubProfileBudgetProjection[];
}

export interface RedskilledGithubBudgetGateway extends RedskilledGithubGateway {
  projectBudget(authority: RedskilledGithubProjectAuthority): RedskilledGithubProjectBudgetProjection;
  hostBudget(): RedskilledGithubHostBudgetProjection;
}

export interface RedskilledGithubManagedBudgetGateway extends RedskilledGithubManagedGateway {
  projectBudget(authority: RedskilledGithubProjectAuthority): RedskilledGithubProjectBudgetProjection;
  hostBudget(): RedskilledGithubHostBudgetProjection;
}

export interface BudgetObservation {
  readonly facts: RedskilledGithubBudgetFacts | null;
  readonly state: Exclude<RedskilledGithubBudgetEvidenceState, "unknown">;
  readonly observedAt: string;
  readonly backpressure?: GithubLimitFact;
}

const BUDGET_POOLS = ["rest", "graphql", "search"] as const;

export function projectPools(
  profile: string,
  observations: ReadonlyMap<string, BudgetObservation>,
  now: string,
): RedskilledGithubPoolBudgetProjection[] {
  return BUDGET_POOLS.map((pool) => budgetProjection(pool, observations.get(budgetKey(profile, pool)), now));
}

export function budgetKey(profile: string, pool: RedskilledGithubBudgetPool): string {
  return `${profile}\u0000${pool}`;
}

export function poolForRead(read: RedskilledGithubRead): RedskilledGithubBudgetPool | null {
  if (read.kind === "graphql") return "graphql";
  if (read.kind === "repository-fetch") return null;
  return read.path.replace(/^\/+/, "").startsWith("search/") ? "search" : "rest";
}

export function publishableProfile(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

function budgetProjection(
  pool: RedskilledGithubBudgetPool,
  observation: BudgetObservation | undefined,
  now: string,
): RedskilledGithubPoolBudgetProjection {
  const facts = observation?.facts ?? null;
  const remaining = facts?.remaining ?? null;
  const limit = facts?.limit ?? null;
  const used = remaining == null || limit == null ? null : Math.max(0, limit - remaining);
  const ageMs = observation == null ? null : Math.max(0, Date.parse(now) - Date.parse(observation.observedAt));
  const state = observation?.state ?? "unknown";
  const warning = budgetWarning(state, remaining, limit);
  const backpressure = observation?.backpressure;
  return {
    pool,
    remaining,
    used,
    limit,
    reset_at: facts?.reset_at ?? null,
    retry_at: backpressure?.retry_at ?? null,
    evidence: {
      state,
      authority: state === "authoritative" ? "github" : state === "cached" ? "redskilled-cache" : "redskilled-gateway",
      observed_at: observation?.observedAt ?? null,
      age_ms: Number.isFinite(ageMs) ? ageMs : null,
      fresh: state === "authoritative" || state === "cached",
    },
    active_backpressure: backpressure == null ? null : {
      kind: backpressure.kind,
      pool: backpressure.pool,
      retry_at: backpressure.retry_at,
      evidence: backpressure.evidence,
    },
    presentation: { warning, density: warning === "normal" ? "compact" : "expanded" },
  };
}

function budgetWarning(
  state: RedskilledGithubBudgetEvidenceState,
  remaining: number | null,
  limit: number | null,
): RedskilledGithubBudgetPresentation["warning"] {
  if (state === "backpressured") return "critical";
  if (state === "unknown" || state === "unavailable" || remaining == null || limit == null || limit <= 0) {
    return "unknown";
  }
  const share = remaining / limit;
  if (share <= 0.1) return "critical";
  if (share <= 0.25) return "warning";
  return "normal";
}
