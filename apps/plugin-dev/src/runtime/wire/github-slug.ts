// github-slug — `owner/name` read out of the checkout's own git config.
//
// It lived in the statusline count cache because that cache was what needed a
// repository to ask GitHub about. The counters are the daemon's now (ADR 0141
// decision 2) and the cache is gone, but the inference is not about counting
// anything: it answers "which repository is this checkout" from files alone, for
// every caller that needs a slug without spending a `gh repo view`.
//
// PURE except for the git-config reads, and fail-open at every step: an
// unreadable config, a remote that is not GitHub, or no remote at all yields "",
// which every caller already treats as "unresolved".

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function parseGitHubRepoSlugFromRemoteUrl(url: string): string {
  const trimmed = url.trim();
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return ssh[1] ?? "";
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (https) return https[1] ?? "";
  return "";
}

function readGitFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function inferGitHubRepoSlug(root: string): string {
  const dotGit = join(root, ".git");
  const gitMarker = readGitFile(dotGit);
  const configCandidates = [join(dotGit, "config")];
  const gitDir = /^gitdir:\s*(.+)$/m.exec(gitMarker)?.[1]?.trim();
  if (gitDir) {
    const absoluteGitDir = gitDir.startsWith("/") ? gitDir : join(root, gitDir);
    configCandidates.push(join(absoluteGitDir, "config"));
    configCandidates.push(join(absoluteGitDir, "..", "..", "config"));
  }
  for (const configPath of configCandidates) {
    const config = readGitFile(configPath);
    const origin = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)\n/.exec(`${config}\n`)?.[1];
    const slug = origin ? parseGitHubRepoSlugFromRemoteUrl(origin) : "";
    if (slug) return slug;
  }
  return "";
}
