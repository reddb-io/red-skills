#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

function truthy(value) {
  return /^(1|true|yes|y)$/i.test(String(value ?? "").trim());
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trimEnd();
}

function latestVersionTag() {
  return git(["tag", "--list", "v*.*.*", "--sort=-v:refname"])
    .split("\n")
    .filter(Boolean)[0] ?? "";
}

function commitsFromFixture(path) {
  const commits = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(commits)) {
    throw new Error(`commit fixture must be an array: ${path}`);
  }
  return commits.map((commit) => ({
    hash: String(commit.hash ?? ""),
    subject: String(commit.subject ?? ""),
    body: String(commit.body ?? ""),
  }));
}

function commitsFromGit(range) {
  const raw = execFileSync(
    "git",
    ["log", range, `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%b${RECORD_SEPARATOR}`],
    { encoding: "utf8" },
  );

  return raw
    .split(RECORD_SEPARATOR)
    .map((record) => record.trimEnd())
    .filter(Boolean)
    .map((record) => {
      const [hash = "", subject = "", body = ""] = record.split(FIELD_SEPARATOR);
      return { hash, subject, body };
    });
}

function loadCommits() {
  if (process.env.RED_RELEASE_COMMIT_FIXTURE) {
    return {
      previous: "",
      commits: commitsFromFixture(process.env.RED_RELEASE_COMMIT_FIXTURE),
    };
  }

  const previous = latestVersionTag();
  const range = previous ? `${previous}..HEAD` : "HEAD";
  return { previous, commits: commitsFromGit(range) };
}

function commitText(commit) {
  return `${commit.subject}\n${commit.body}`;
}

function breakingRequested(commit) {
  return /(^|\n)(feat|fix)(\([^)]*\))?!:/.test(commitText(commit)) ||
    /(^|\n)BREAKING CHANGE/.test(commitText(commit));
}

function featureRequested(commit) {
  return /(^|\n)feat(\([^)]*\))?:/.test(commitText(commit));
}

function fixRequested(commit) {
  return /(^|\n)fix(\([^)]*\))?:/.test(commitText(commit));
}

function commitLabel(commit) {
  const shortHash = commit.hash ? commit.hash.slice(0, 8) : "unknown";
  return `${shortHash} ${commit.subject}`.trim();
}

function decideBumpKind(commits, allowMajor) {
  const breakingCommits = commits.filter(breakingRequested);
  if (breakingCommits.length > 0) {
    if (allowMajor) {
      return {
        kind: "major",
        consumeMajorOptIn: true,
        warning: "",
      };
    }

    return {
      kind: "minor",
      consumeMajorOptIn: false,
      warning: `::warning::Breaking-change markers requested a major bump, but RED_RELEASE_ALLOW_MAJOR is not true; degrading to minor. Offending commits: ${breakingCommits.map(commitLabel).join("; ")}`,
    };
  }

  if (commits.some(featureRequested)) {
    return { kind: "minor", consumeMajorOptIn: false, warning: "" };
  }

  if (commits.some(fixRequested)) {
    return { kind: "patch", consumeMajorOptIn: false, warning: "" };
  }

  return {
    kind: "none",
    consumeMajorOptIn: false,
    warning: commits.length > 0
      ? `::warning::red-release skipped ${commits.length} non-releasable commit(s) with no feat/fix conventional type: ${commits.map(commitLabel).join("; ")}`
      : "",
  };
}

function writeOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

const { previous, commits } = loadCommits();
const decision = decideBumpKind(commits, truthy(process.env.RED_RELEASE_ALLOW_MAJOR));

if (decision.warning) {
  console.log(decision.warning);
}

writeOutput("previous", previous);
writeOutput("kind", decision.kind);
writeOutput("consume_major_opt_in", String(decision.consumeMajorOptIn));

console.log(`Bump kind: ${decision.kind} (previous tag: ${previous || "none"})`);
