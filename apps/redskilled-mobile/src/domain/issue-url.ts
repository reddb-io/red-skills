export interface GitHubIssueReference {
  readonly owner: string;
  readonly repository: string;
  readonly ticket: number;
  readonly canonicalUrl: string;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

export class InvalidGitHubIssueUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGitHubIssueUrlError";
  }
}

export function parseGitHubIssueUrl(input: string): GitHubIssueReference {
  const text = input.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new InvalidGitHubIssueUrlError("Issue URL is not a valid URL");
  }

  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new InvalidGitHubIssueUrlError(
      "Issue URL must use https://github.com",
    );
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 4 || segments[2] !== "issues") {
    throw new InvalidGitHubIssueUrlError(
      "Issue URL must match /owner/repository/issues/number",
    );
  }

  const [owner, repository, , ticketText] = segments;
  if (
    owner == null ||
    repository == null ||
    ticketText == null ||
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repository)
  ) {
    throw new InvalidGitHubIssueUrlError(
      "Issue URL contains an invalid owner or repository",
    );
  }

  if (!/^[1-9][0-9]*$/.test(ticketText)) {
    throw new InvalidGitHubIssueUrlError(
      "Issue URL must end in a positive issue number",
    );
  }
  const ticket = Number(ticketText);
  if (!Number.isSafeInteger(ticket)) {
    throw new InvalidGitHubIssueUrlError("Issue number is too large");
  }

  return {
    owner,
    repository,
    ticket,
    canonicalUrl: `https://github.com/${owner}/${repository}/issues/${ticket}`,
  };
}
