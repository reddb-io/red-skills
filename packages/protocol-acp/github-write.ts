// github-write — the `_redskills/github_write` params shape (ADR 0148).
//
// A Worker holds no GitHub credential. When it needs to publish — a checkpoint
// push under Budget grace, a Ticket comment, a pull request — it asks
// redskilled's Project-bound gateway and the daemon performs the write. The
// REQUEST is therefore wire and lives here; custody, idempotency durability,
// rate accounting and the upstream call all stay with the gateway.
export type RedskilledGithubWrite =
  | { readonly kind: "repository-push"; readonly ref: string; readonly sha: string }
  | {
      readonly kind: "pull-request";
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    }
  | {
      /**
       * Move a Ticket's state labels as one authorized mutation (#4160).
       *
       * A gate-blocked verdict that changes nothing on the tracker leaves the
       * Ticket at the head of the ready queue, so every freed slot re-births a
       * Worker for the same item. The transition is what makes the queue
       * advance; the optional comment explains it in the same write.
       */
      readonly kind: "issue-transition";
      readonly issue: number;
      readonly add: readonly string[];
      readonly remove: readonly string[];
      readonly comment?: string;
    }
  | {
      readonly kind: "issue-publication";
      /** Absent to open a Ticket; present to publish a comment on that Ticket. */
      readonly issue?: number;
      readonly title?: string;
      readonly body: string;
      /**
       * Labels stamped on a NEWLY opened Ticket.
       *
       * A lane label decides who may claim the Ticket, so stamping it in the
       * same authorized write that opens it is what keeps an unlabelled Ticket
       * from existing at all.
       */
      readonly labels?: readonly string[];
    };

export interface RedskilledGithubWriteRequest {
  /** Stable caller-minted identity. Reusing it returns the durable receipt. */
  readonly idempotency_key: string;
  readonly write: RedskilledGithubWrite;
}
