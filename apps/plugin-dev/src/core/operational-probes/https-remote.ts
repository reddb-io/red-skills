import type {
  OperationalProbe,
  OperationalProbeContext,
  OperationalProbeFixDeps,
  OperationalProbeFixResult,
  OperationalProbeResult,
  RemoteUrlFact,
} from "./types.js";

interface HttpsRemoteFindingData {
  readonly remotes: readonly Required<Pick<RemoteUrlFact, "url">>[];
  readonly fixable: readonly { readonly name: string; readonly url: string }[];
}

export const HTTPS_REMOTE_PROBE_ID = "git.remote.https-forbidden";
export const HTTPS_REMOTE_PROBE_NAME = "SSH-only git remotes";
export const HTTPS_REMOTE_CANONICAL_FIX =
  "Use SSH git remotes for local AFK boot, or run in the Actions lane where https remotes are explicitly allowed.";

function normalizeRemote(remote: string | RemoteUrlFact): RemoteUrlFact {
  return typeof remote === "string" ? { url: remote } : remote;
}

function httpsRemotes(context: OperationalProbeContext): RemoteUrlFact[] {
  if (context.allowHttpsRemote) return [];
  return context.remoteUrls.map(normalizeRemote).filter((remote) => remote.url.startsWith("https://"));
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function toSshRemoteUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !url.hostname || !url.pathname) return undefined;
    const repoPath = url.pathname.replace(/^\/+/, "");
    if (!repoPath) return undefined;
    return `git@${url.hostname}:${repoPath}`;
  } catch {
    return undefined;
  }
}

export function runHttpsRemoteProbe(context: OperationalProbeContext): OperationalProbeResult {
  const bad = httpsRemotes(context);
  if (bad.length === 0) {
    return {
      id: HTTPS_REMOTE_PROBE_ID,
      name: HTTPS_REMOTE_PROBE_NAME,
      verdict: "ok",
      evidence: "no forbidden https remotes observed",
      canonicalFix: HTTPS_REMOTE_CANONICAL_FIX,
    };
  }

  const fixable = bad.flatMap((remote) => {
    const next = remote.name ? toSshRemoteUrl(remote.url) : undefined;
    return remote.name && next ? [{ name: remote.name, url: next }] : [];
  });

  return {
    id: HTTPS_REMOTE_PROBE_ID,
    name: HTTPS_REMOTE_PROBE_NAME,
    verdict: "red",
    evidence: `${bad.length} forbidden https ${plural(bad.length, "remote")} observed`,
    canonicalFix: HTTPS_REMOTE_CANONICAL_FIX,
    fix: {
      gate: "confirm",
      description: "rewrite named https remotes to SSH remotes",
    },
    data: {
      remotes: bad.map((remote) => ({ url: remote.url })),
      fixable,
    } satisfies HttpsRemoteFindingData,
  };
}

export async function applyHttpsRemoteFix(
  finding: OperationalProbeResult,
  deps: OperationalProbeFixDeps,
): Promise<OperationalProbeFixResult> {
  const confirmed = await deps.confirm(finding);
  if (!confirmed) {
    return { probeId: finding.id, status: "declined", evidence: "operator declined fix" };
  }

  const data = finding.data as Partial<HttpsRemoteFindingData> | undefined;
  const fixable = data?.fixable ?? [];
  if (!deps.setRemoteUrl || fixable.length === 0) {
    return { probeId: finding.id, status: "noop", evidence: "no named https remote could be rewritten" };
  }

  for (const remote of fixable) {
    await deps.setRemoteUrl(remote.name, remote.url);
  }
  return {
    probeId: finding.id,
    status: "applied",
    evidence: `rewrote ${fixable.length} ${plural(fixable.length, "remote")}`,
  };
}

export const httpsRemoteProbe: OperationalProbe = {
  id: HTTPS_REMOTE_PROBE_ID,
  name: HTTPS_REMOTE_PROBE_NAME,
  canonicalFix: HTTPS_REMOTE_CANONICAL_FIX,
  run: runHttpsRemoteProbe,
  applyFix: applyHttpsRemoteFix,
};
