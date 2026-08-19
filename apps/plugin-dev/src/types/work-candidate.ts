// work-candidate — what one queued item looks like to the surfaces that list it.
//
// These two types outlived the session loop that used to own them. The loop —
// `select_issues`, the outer drain, `processIssue` — was the dev CLI's engine,
// deleted with the binary (#4031) and finally removed from the tree; what still
// reads a candidate is the queue listing behind `queue_status`.
//
// **A type whose home describes a dead thing teaches the wrong architecture**,
// so they live here rather than in a file named after an orchestrator this
// repository no longer has.
import type { WorkSelector } from "@reddb-io/worker/engine";

export interface IssueCandidate {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /**
   * GitHub login of the issue author; a `user` selector facet never matches a
   * candidate without it.
   */
  author?: string;
}

/**
 * How a listing narrows the queue. `issues` keeps the argument order, `spec`
 * keeps spec-linked Tickets, `all` keeps every remainder, and `selector` is the
 * project's declared work scope — every facet present narrows the pool.
 */
export type SelectionFilter =
  | { kind: "all" }
  | { kind: "issues"; numbers: number[] }
  | { kind: "spec"; spec: number }
  | { kind: "selector"; selector: WorkSelector };
