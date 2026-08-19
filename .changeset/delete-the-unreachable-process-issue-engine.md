---
"@reddb-io/red-skills": patch
---

Delete `processIssue` and the session loop: 16,000 lines nothing could reach

#4031 deleted the dev CLI's binary and its router and **kept the bodies**. An
import walk from the dev bundle's only shipped entry (`src/mcp-server.ts`),
counting runtime edges and ignoring `import type`, found ~46,500 lines in
`apps/plugin-dev/src` with no path to execution. This is the first and largest
cone of it: `processIssue`, its terminal, recovery, re-seed and validation
modules, and the outer session loop that composed them.

**They were green the whole time.** Their tests imported them directly, so CI
kept proving an engine no shipped code could call — which is exactly how this
kind of residue survives review.

What moved rather than died: `IssueCandidate` and `SelectionFilter`, the two
types the live queue listing still reads, now live in `src/types/work-candidate.ts`
— a type whose home describes a dead thing teaches the wrong architecture. And
three ratchets that pinned rules **inside** the deleted engine now pin them
where the rules live: the lane-to-mode contract is refused in the ACP Worker's
ticket loop, and the Worker's trunk-fetch ban is its own terminal policy. The
shrink-only baselines shrink, which is the direction they allow.
