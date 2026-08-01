#!/usr/bin/env bash
# Cut the release tag for a merged Version Packages PR (ADR 0121).
#
# The tag target is the BUMP COMMIT ITSELF, carried in from the push event
# payload as BUMP_SHA (`github.sha`) — never the working tree, never HEAD, and
# never the live state of `.changeset/`. A merge landing between the Version
# Packages PR merge and this run rewrites that directory, which made the bump
# look un-merged and swallowed two tags in silence on 2026-08-01.
#
# Every decision NOT to cut prints a `::notice::` naming its reason: a release
# that quietly skips reads exactly like a release that succeeded.

set -euo pipefail

sha="${BUMP_SHA:-}"
remote="${RELEASE_REMOTE:-origin}"

notice() { printf '::notice::%s\n' "$*"; }
die() { printf '::error::%s\n' "$*" >&2; exit 1; }

emit_output() {
  [ -n "${GITHUB_OUTPUT:-}" ] || return 0
  printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
}

[ -n "$sha" ] ||
  die "release cut: BUMP_SHA is empty — the push event carried no commit sha"

git cat-file -e "${sha}^{commit}" 2>/dev/null ||
  die "release cut: bump commit ${sha} is not in this checkout (the cut needs fetch-depth: 0)"

sha="$(git rev-parse "${sha}^{commit}")"

# Everything below is read out of the bump commit's own tree. The working tree
# may already carry a later merge, and every answer it gives belongs to
# somebody else's commit.
package_json="$(git show "${sha}:package.json" 2>/dev/null)" ||
  die "release cut: ${sha} has no package.json to read a version from"

version="$(printf '%s' "$package_json" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => { raw += d; });
  process.stdin.on("end", () => {
    const version = JSON.parse(raw).version;
    if (typeof version !== "string" || version === "") process.exit(1);
    process.stdout.write(version);
  });
')" || die "release cut: ${sha} carries no readable package.json version"

tag="v${version}"

# Pending changesets AT THE BUMP COMMIT mean the Version Packages PR has not
# merged yet — this push is an ordinary commit, and there is nothing to cut.
pending="$(
  git ls-tree -r --name-only "$sha" -- .changeset |
    { grep -E '^\.changeset/[^/]+\.md$' || true; } |
    { grep -vE '^\.changeset/README\.md$' || true; } |
    wc -l | tr -d '[:space:]'
)"
if [ "$pending" != "0" ]; then
  notice "no cut at ${sha}: ${pending} pending changeset(s) in that commit — the Version Packages PR has not merged yet"
  exit 0
fi

existing="$(git rev-parse -q --verify "refs/tags/${tag}^{commit}" || true)"
if [ -n "$existing" ]; then
  if [ "$existing" = "$sha" ]; then
    notice "no cut at ${sha}: ${tag} already points at this bump commit — release already cut"
  else
    notice "no cut at ${sha}: ${tag} already exists at ${existing} — version ${version} was released from another commit"
  fi
  exit 0
fi

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git tag -a "$tag" -m "Release $tag" "$sha"
git push "$remote" "refs/tags/${tag}"

emit_output "tag=${tag}"
emit_output "sha=${sha}"
notice "cut ${tag} at ${sha}; dispatching red-publish"
