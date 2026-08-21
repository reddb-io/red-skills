// publication — the `_redskills/publish` and `_redskills/land` params (ADR 0144 §3, ADR 0148).
//
// The Worker's terminal policy refuses `git push` and `gh` (#4016). These two
// methods are the promise that refusal made: the Worker names the branch and
// the commit its turn produced, and the daemon — which holds the Project's
// credential profile, its canonical workspace and its remote — performs the
// write. Only the REQUEST is wire; the credential, the remote and the Worktree
// the objects come from are daemon authority and stay behind the socket.
//
// Two things a request may NOT name, and the reason each is absent:
//
//   - **Which Worker is asking.** The connection already answers that. A
//     `worker_id` in the params would let any peer publish as any Worker, which
//     is precisely the authority the daemon is holding on their behalf.
//   - **Which Project, remote or credential profile.** Naming one would make a
//     Worker the chooser of where its work lands, and there would be nothing
//     left for the gateway to enforce.

/** Push one commit the Worker's turn produced onto its branch. */
export interface RedskilledPublishRequest {
  /** Stable caller-minted identity. Reusing it returns the durable receipt. */
  readonly idempotency_key: string;
  /** The branch the inner agent committed on, without its `refs/heads/` prefix. */
  readonly branch: string;
  /** The commit that branch points at, as a full 40-character object name. */
  readonly commit: string;
}

export interface RedskilledPublishAnswer {
  readonly version: 1;
  /** The Worker the daemon published FOR, resolved from the connection. */
  readonly worker_id: string;
  readonly branch: string;
  readonly commit: string;
  readonly published_at: string;
}

/**
 * Open the pull request for a published branch and hand its merge to custody.
 *
 * `owner_ticket` is the Ticket that inherits the merge when the Worker is gone,
 * which is why landing can return before the merge happens (ADR 0144 §3).
 */
export interface RedskilledLandRequest {
  readonly idempotency_key: string;
  readonly branch: string;
  /**
   * The commit this landing is FOR — the same full object name its publish
   * carried (#4130). Publish validated it; a land without it would hand
   * custody a mutable branch ref, and the merge driver could not tell an
   * armed head from one that moved after arming.
   */
  readonly commit: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  readonly owner_ticket: number;
}

export interface RedskilledLandAnswer {
  readonly version: 1;
  readonly worker_id: string;
  readonly pull_request: number;
  readonly branch: string;
  readonly base: string;
  /**
   * The custody the daemon accepted, NEVER the merge's outcome.
   *
   * `active` is the ordinary answer to a successful landing: the Queue
   * Custodian now owns "this pull request ends merged", and the Worker that
   * asked is free to die.
   */
  readonly custody_state: "active" | "terminal";
  readonly handed_off_at: string;
}
