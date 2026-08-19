import { gh, safeSh, sh } from "./common";
import { parseDiffLines } from "./diff-lines";
import { planGithubRestRead } from "@reddb-io/github";

export interface ReviewThreadComment {
  readonly commentId: string;
  readonly threadId: string;
  readonly path: string | null;
  readonly line: number | null;
  readonly author: string;
  readonly body: string;
}

export interface PullRequestContext {
  readonly prTitle: string;
  readonly prBody: string;
  readonly issueNumber: string;
  readonly issueTitle: string;
  readonly linkedIssue: string;
  readonly diff: string;
  readonly prCommentsJson: string;
  readonly diffLines: Map<string, Set<number>>;
  readonly validReplyIds: Set<string>;
}

export const fetchPullRequestContext = (
  prNumber: string,
): PullRequestContext => {
  const repoSlug = process.env.GH_REPO || "{owner}/{repo}";
  const rest = (path: string, args: readonly string[] = []): string => {
    const plan = planGithubRestRead({ kind: "rest", path, args });
    if (plan.outcome !== "plan") throw new Error(plan.reason);
    return gh(plan.args);
  };
  const prPlan = planGithubRestRead({ kind: "pr", number: Number(prNumber), fields: ["title", "body"], ...(repoSlug.includes("{") ? {} : { repo: repoSlug }) });
  if (prPlan.outcome !== "plan") throw new Error(prPlan.reason);
  const pr = prPlan.decode(gh(prPlan.args));
  const comments = JSON.parse(rest(`repos/${repoSlug}/issues/${prNumber}/comments`)) as Array<{
    user?: { login?: string } | null;
    body?: string;
    created_at?: string;
  }>;
  const prView = {
    title: String(pr.title ?? ""),
    body: String(pr.body ?? ""),
    comments: comments.map((comment) => ({
      author: { login: comment.user?.login ?? "" },
      body: comment.body ?? "",
      createdAt: comment.created_at,
    })),
  } as {
    title: string;
    body?: string | null;
    comments: {
      author?: { login: string } | null;
      body: string;
      createdAt?: string;
    }[];
  };

  const issueMatch = (prView.body ?? "").match(
    /(?:closes|fixes|resolves)\s+#(\d+)/i,
  );
  const issueNumber = issueMatch?.[1] ?? "";
  const issuePlan = issueNumber ? planGithubRestRead({ kind: "issue", number: Number(issueNumber), fields: ["title", "body"], ...(repoSlug.includes("{") ? {} : { repo: repoSlug }) }) : null;
  const issue = issuePlan?.outcome === "plan" ? issuePlan.decode(gh(issuePlan.args)) : {};
  const issueTitle = String(issue.title ?? "");
  const linkedIssue = issueNumber
    ? JSON.stringify({ ...issue, comments: JSON.parse(rest(`repos/${repoSlug}/issues/${issueNumber}/comments`)) })
    : "(no linked issue found)";

  const reviews = JSON.parse(
    rest(`repos/${repoSlug}/pulls/${prNumber}/reviews`),
  ) as {
    user?: { login: string } | null;
    body?: string | null;
    state: string;
    submitted_at?: string | null;
  }[];

  const [owner, repo] = (process.env.GH_REPO ?? "").split("/");
  const query = `
query($owner:String!,$repo:String!,$number:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          comments(first:50) {
            nodes {
              id
              path
              line
              originalLine
              body
              author { login }
            }
          }
        }
      }
    }
  }
}`;

  const threadsPlan = planGithubRestRead({
    kind: "graphql",
    query,
    variables: { owner: owner ?? "", repo: repo ?? "", number: Number(prNumber) },
  });
  if (threadsPlan.outcome !== "plan") throw new Error(threadsPlan.reason);
  const threadsParsed = JSON.parse(gh(threadsPlan.args)) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes?: {
              id: string;
              isResolved: boolean;
              comments: {
                nodes: {
                  id: string;
                  path: string | null;
                  line: number | null;
                  originalLine: number | null;
                  body: string;
                  author?: { login: string } | null;
                }[];
              };
            }[];
          };
        };
      };
    };
  };

  const unresolvedThreads =
    threadsParsed.data?.repository?.pullRequest?.reviewThreads?.nodes?.filter(
      (thread) => !thread.isResolved,
    ) ?? [];

  const reviewThreads: ReviewThreadComment[] = unresolvedThreads.flatMap(
    (thread) =>
      thread.comments.nodes.map((comment) => ({
        commentId: comment.id,
        threadId: thread.id,
        path: comment.path,
        line: comment.line ?? comment.originalLine,
        author: comment.author?.login ?? "unknown",
        body: comment.body,
      })),
  );

  const prComments = {
    issue_comments: prView.comments.map((comment) => ({
      author: comment.author?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.createdAt,
    })),
    review_summaries: reviews
      .filter((review) => review.body && review.body.trim().length > 0)
      .map((review) => ({
        author: review.user?.login ?? "unknown",
        state: review.state,
        body: review.body,
        submittedAt: review.submitted_at,
      })),
    review_threads: reviewThreads,
  };

  const diff = safeSh("git diff main...HEAD") || sh("git diff main..HEAD");

  return {
    prTitle: prView.title,
    prBody: prView.body ?? "",
    issueNumber,
    issueTitle,
    linkedIssue,
    diff,
    prCommentsJson: JSON.stringify(prComments, null, 2),
    diffLines: parseDiffLines(diff),
    validReplyIds: new Set(reviewThreads.map((comment) => comment.commentId)),
  };
};
