export interface TrackerIssue {
  readonly number: number;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface TrackerIssueReference {
  readonly number: number;
  readonly title?: string;
  readonly url?: string;
}

export interface TrackerIssueCreateSpec {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
}

export interface TrackerLabelMutation {
  readonly remove: readonly string[];
  readonly add: readonly string[];
}

export type TrackerClaimLiveness = "alive" | "dead" | "unknown";

export interface TrackerClaimLeaseRequest {
  readonly issue: number;
  readonly worker: string;
  readonly runner?: string;
  readonly liveness: (worker: string) => TrackerClaimLiveness;
}

export interface TrackerClaimRetireRequest {
  readonly issue: number;
  readonly worker: string;
  readonly runner?: string;
}

export interface TrackerClaimDecision {
  readonly verdict: "won" | "lost";
  readonly winner: string | null;
  readonly reason: string;
  readonly winnerClaimId?: number;
  readonly recovered: readonly string[];
}

export interface TrackerPort {
  createIssue?(spec: TrackerIssueCreateSpec): Promise<number>;
  listOpenIssuesByLabel(label: string): Promise<TrackerIssue[]>;
  /** CLOSED issues carrying ANY of `labels`, at most `limit` of them — the
   * external-close reconcile lane (#2749). A close performed outside the
   * engine (GitHub's own PR-closes-issue on a human merge) leaves whatever
   * state the issue was in; this read is how the curator finds it. Optional so
   * read-only and legacy adapters keep working — the reconcile pass no-ops when
   * the adapter omits it. */
  listClosedIssuesByAnyLabel?(
    labels: readonly string[],
    limit: number,
  ): Promise<TrackerIssue[]>;
  isIssueClosed(issue: number): Promise<boolean>;
  editIssueLabels(issue: number, mutation: TrackerLabelMutation): Promise<void>;
  /** Replace an issue body while preserving the tracker abstraction. Optional
   * for read-only/legacy adapters; the quarantine curator requires it. */
  editIssueBody?(issue: number, body: string): Promise<void>;
  commentOnIssue(issue: number, body: string): Promise<void>;
  closeIssue(issue: number): Promise<void>;
  issueReference?(issue: number): Promise<TrackerIssueReference | undefined>;
  claimIssueLease?(
    request: TrackerClaimLeaseRequest,
  ): Promise<TrackerClaimDecision>;
  retireIssueLease?(request: TrackerClaimRetireRequest): Promise<void>;
}
