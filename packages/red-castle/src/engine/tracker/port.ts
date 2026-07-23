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
