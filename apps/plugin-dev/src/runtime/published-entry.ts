/**
 * published-entry — which VERSION a Worker born right now would report.
 *
 * The answer used to be a PATH. A project's Worker inherited whatever bundle the
 * launching process happened to run, so a project stranded by a release could
 * not be repaired by restarting it: the MCP server's own plugin-cache bundle was
 * older still, the prescribed fix produced a WIDER skew, and every Worker kept
 * boot-halting (#2808, same defect class as #2736/#2677 — never infer the
 * executable from the caller's argv). This module answered by resolving the
 * published version first and then finding an entry that ran THAT version.
 *
 * **The search is gone, and the question is not.** ADR 0147 deleted the dev
 * bundle every candidate path named, and ADR 0148 makes the daemon compose its
 * own `redskilled acp-worker` launch — a client checkout is never an execution
 * input, so nothing here names an executable any more. What survives is the
 * comparison the engine floor and the fleet-truth probe both ask: WHICH VERSION
 * is on the published lane. `published-version.ts` records the same fact for the
 * reporting surfaces (#2809), and a disagreement between the two is the bug
 * class rather than a detail.
 */
import { readBuildInfo } from "@reddb-io/build-info";
import { resolvePublishedDevBundleVersion, semverParts } from "../core/bundle-version.js";

/** Injected environment. Every field defaults to this process, so tests can pose as a stale host. */
export interface PublishedEntryLookup {
  env?: NodeJS.ProcessEnv;
  /** The asking process's own bundle version (build info by default). */
  installedVersion?: string;
  /** Published-version resolver; defaults to the one the boot probe reads. */
  resolvePublished?: (installed: string, env: NodeJS.ProcessEnv) => string | undefined;
}

/**
 * A source checkout or unreleased build (`0.0.0-dev`, any prerelease) is not a
 * point on the published lane, so it never redirects: the developer's own build
 * is the intended runtime, and comparing it to a cached release is meaningless.
 */
export function isLocalDevBuild(version: string): boolean {
  return /^\d+\.\d+\.\d+[-+]/.test(version.trim());
}

/**
 * The version a Worker born right now would report. Never throws — a stamp that
 * cannot resolve the published version still records the asking bundle, because
 * an absent version reads as unknown, not as skewed.
 */
export function publishedEntryVersion(lookup: PublishedEntryLookup = {}): string {
  const env = lookup.env ?? process.env;
  const installed = (lookup.installedVersion ?? readBuildInfo("dev").version).trim();
  if (isLocalDevBuild(installed)) return installed;
  let published: string | undefined;
  try {
    published = (lookup.resolvePublished ?? resolvePublishedDevBundleVersion)(installed, env);
  } catch {
    return installed;
  }
  if (!published || semverParts(published) === null) return installed;
  return published;
}
