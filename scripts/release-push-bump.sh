#!/usr/bin/env bash
# Push the `chore(release): vX.Y.Z` manifest-bump commit to the default branch.
#
# main carries classic branch protection with `test` and `typecheck` as required
# status checks. A commit the release job just created can never carry those
# contexts at push time, so a plain `git push origin HEAD:main` from the
# workflow's GITHUB_TOKEN is declined with:
#
#   remote: error: GH006: Protected branch update failed for refs/heads/main.
#   remote: - 2 of 2 required status checks are expected.
#
# Three layered strategies, most-preferred first:
#
#   1. RED_RELEASE_TOKEN — a repo-admin PAT or GitHub App installation token
#      with contents:write. `enforce_admins` is disabled on main, so an admin
#      credential pushes straight through while PR protection stays exactly as
#      strict as it is for everyone else. Set this secret and the release is
#      fully automatic again.
#   2. rebase-and-retry — red-memory-wiki-extract.yml also pushes to main, so
#      the bump push can simply lose a race. Rebase with --autostash: the
#      release build leaves generated files dirty, and a plain rebase aborts
#      with "cannot rebase: You have unstaged changes".
#   3. side-branch + PR — when protection itself declines the commit, park the
#      bump on `release/bump-vX.Y.Z`, open a PR, and RETURN SUCCESS. npm is
#      already published at this point; failing here would leave a partial
#      release with no tag and no GitHub Release. Better a loud warning plus a
#      one-click PR than a half-cut release.
#
# Env:
#   NEXT                (required) release version, e.g. v2.77.0
#   BASE_BRANCH         default: main
#   PUSH_REMOTE         default: origin
#   BUMP_PUSH_ATTEMPTS  default: 3
#   RED_RELEASE_TOKEN   optional bypass-capable token
#   GITHUB_REPOSITORY   owner/repo, required to use RED_RELEASE_TOKEN

set -euo pipefail

NEXT="${NEXT:?NEXT (release version) is required}"
BASE_BRANCH="${BASE_BRANCH:-main}"
PUSH_REMOTE="${PUSH_REMOTE:-origin}"
ATTEMPTS="${BUMP_PUSH_ATTEMPTS:-3}"

target="$PUSH_REMOTE"
if [ -n "${RED_RELEASE_TOKEN:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  git remote remove release-push >/dev/null 2>&1 || true
  git remote add release-push "https://x-access-token:${RED_RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
  target=release-push
  echo "bump push: using the bypass-capable RED_RELEASE_TOKEN credentials"
else
  echo "bump push: RED_RELEASE_TOKEN absent — using the default workflow credentials"
fi

pushed=0
protected=0
attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  if out="$(git push "$target" "HEAD:$BASE_BRANCH" 2>&1)"; then
    printf '%s\n' "$out"
    pushed=1
    break
  fi
  printf '%s\n' "$out" >&2
  case "$out" in
    *GH006* | *"protected branch hook declined"* | *"required status checks"*)
      # Branch protection declined the commit itself — a rebase changes nothing
      # about the missing status contexts, so retrying is pure noise.
      protected=1
      break
      ;;
  esac
  echo "push rejected (attempt $attempt) — rebasing onto $PUSH_REMOTE/$BASE_BRANCH"
  if ! git fetch "$PUSH_REMOTE" "$BASE_BRANCH"; then
    echo "::error::cannot fetch $PUSH_REMOTE/$BASE_BRANCH to retry the $NEXT bump push"
    exit 1
  fi
  if ! git rebase --autostash FETCH_HEAD; then
    git rebase --abort >/dev/null 2>&1 || true
    echo "::error::rebase of the $NEXT bump commit onto $PUSH_REMOTE/$BASE_BRANCH failed"
    exit 1
  fi
  attempt=$((attempt + 1))
done

if [ "$pushed" = 1 ]; then
  echo "bump commit for $NEXT pushed to $BASE_BRANCH"
  exit 0
fi

if [ "$protected" != 1 ]; then
  echo "::error::bump push to $BASE_BRANCH failed after $ATTEMPTS attempts"
  exit 1
fi

branch="release/bump-${NEXT}"
git push --force "$target" "HEAD:refs/heads/${branch}"
echo "::warning::branch protection declined the direct $NEXT bump push to $BASE_BRANCH; the bump is parked on ${branch}. Add a bypass-capable RED_RELEASE_TOKEN secret (repo-admin PAT with contents:write) to restore the direct push."

if command -v gh >/dev/null 2>&1; then
  gh pr create \
    --base "$BASE_BRANCH" \
    --head "$branch" \
    --title "chore(release): ${NEXT} manifest bump" \
    --body "$(printf '%s\n' \
      "Automated manifest bump for \`${NEXT}\`, parked here because branch protection declined the release job's direct push to \`${BASE_BRANCH}\` (GH006: required status checks are expected on a commit the job just created)." \
      "" \
      "\`${NEXT}\` is already published to npm, tagged, and released — only the in-repo manifest versions are waiting on this merge." \
      "" \
      "To make this automatic again, add a bypass-capable \`RED_RELEASE_TOKEN\` repository secret (repo-admin PAT or GitHub App installation token with contents:write). \`enforce_admins\` is off on \`${BASE_BRANCH}\`, so an admin credential pushes through without weakening PR protection." \
      "" \
      "Note: this PR was opened with \`GITHUB_TOKEN\`, whose events cannot trigger \`pull_request\` workflows, so the required checks will not start on their own — merge it as an admin or re-open it from a user account.")" \
    || echo "no new PR opened for ${branch} (one is probably already open)"
else
  echo "::warning::gh CLI unavailable — merge ${branch} into ${BASE_BRANCH} by hand"
fi

exit 0
