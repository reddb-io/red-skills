#!/usr/bin/env bash
# Shared AFK branch-ref construction.
#
# Live refs and failed-attempt snapshot refs must keep the same grammar:
#   afk/{worker}/{issue}-{slug}
#   afk-attempts/{worker}/{issue}-{slug}
#
# The slug is a title slug, not a pre-built branch name. Rejecting slashes in
# the slug blocks the historic double-nested shape:
#   afk-attempts/{worker}/{issue}-afk/{worker}/{issue}-{slug}

afk_ref_slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
    | cut -c1-40
}

afk_ref_validate() {
  local ref="$1"
  [[ "$ref" =~ ^afk(-attempts)?/[A-Za-z0-9._-]+/[0-9]+-[a-z0-9-]+$ ]]
}

afk_ref_build_from_slug() {
  local namespace="$1" worker_id="$2" issue="$3" slug="$4"
  case "$namespace" in
    afk|afk-attempts) ;;
    *) return 2 ;;
  esac
  [[ "$worker_id" =~ ^[A-Za-z0-9._-]+$ ]] || return 2
  [[ "$issue" =~ ^[0-9]+$ ]] || return 2
  [[ "$slug" =~ ^[a-z0-9-]+$ ]] || return 2

  local ref="${namespace}/${worker_id}/${issue}-${slug}"
  afk_ref_validate "$ref" || return 2
  printf '%s\n' "$ref"
}

afk_ref_build() {
  local namespace="$1" worker_id="$2" issue="$3" title="$4"
  local slug
  slug="$(afk_ref_slugify "$title")"
  afk_ref_build_from_slug "$namespace" "$worker_id" "$issue" "$slug"
}
