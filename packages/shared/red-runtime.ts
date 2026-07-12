import { platform, arch } from "node:os";

export const REDDB_REPO = "reddb-io/reddb";
export const RED_RUNTIME_DIR = "reddb";
export const RED_RELEASE_BASE = "https://github.com";

export interface RedRuntimeIO {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  fetchBuffer(url: string): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): string;
}

export interface EnsureRedBinaryInput {
  cacheDir: string;
  binaryTag: string;
  mayFetch: boolean;
  repo?: string;
  releaseBase?: string;
  platformKey?: string | null;
  win32?: boolean;
}

export interface RedBinaryRuntime {
  redPath: string;
  checksumPath: string;
  assetName: string;
  sha256: string;
}

export class RedRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedRuntimeError";
  }
}

export function redPlatformKey(plat = platform(), architecture = arch()): string | null {
  const os = ({ linux: "linux", darwin: "macos", win32: "windows" } as Record<string, string>)[plat];
  const cpu = ({ x64: "x86_64", arm64: "aarch64", arm: "armv7" } as Record<string, string>)[architecture];
  if (!os || !cpu) return null;
  return `${os}-${cpu}`;
}

export function redAssetName(key: string): string {
  return `red-${key}`;
}

export function redBinaryFileName(win32 = process.platform === "win32"): string {
  return win32 ? "red.exe" : "red";
}

export function redRuntimeDir(cacheDir: string, binaryTag: string): string {
  return joinPath(cacheDir, RED_RUNTIME_DIR, stripLeadingV(binaryTag));
}

export function resolveRedBinaryPath(cacheDir: string, binaryTag: string, win32 = process.platform === "win32"): string {
  return joinPath(redRuntimeDir(cacheDir, binaryTag), redBinaryFileName(win32));
}

export function redAssetUrl(
  repo: string,
  tag: string,
  name: string,
  releaseBase = RED_RELEASE_BASE,
): string {
  return `${releaseBase}/${repo}/releases/download/${tag}/${name}`;
}

export function parseSha256File(body: Uint8Array | string): string | null {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  const m = text.match(/\b[0-9a-f]{64}\b/i);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Resolve the cached red binary. Verifies the recorded checksum unless the
 * caller opts out.
 *
 * Verification re-hashes a ~32MB native binary, so the hot path opts out: rsp
 * fronts every wrapped command, and re-verifying per invocation would cost more
 * than the wrapper itself spends. The bytes are checksum-verified at adoption
 * time and a warm cache is trusted from then on, exactly as the memory/brain
 * runtime bootstrap already does. A cache that rots anyway is caught twice over:
 * the cold path re-verifies (and re-fetches on mismatch), and a corrupt binary
 * that reaches a wrapper fails its spawn, which degrades to passthrough (#1522)
 * instead of failing the user's command.
 */
export async function resolveCachedRedBinary(
  io: Pick<RedRuntimeIO, "exists" | "readFile" | "sha256">,
  input: Pick<EnsureRedBinaryInput, "cacheDir" | "binaryTag" | "platformKey" | "win32">,
  opts: { verify?: boolean } = {},
): Promise<RedBinaryRuntime | null> {
  const verify = opts.verify ?? true;
  const key = input.platformKey ?? redPlatformKey();
  if (!key) return null;
  const redPath = resolveRedBinaryPath(input.cacheDir, input.binaryTag, input.win32);
  const checksumPath = `${redPath}.sha256`;
  if (!(await io.exists(redPath)) || !(await io.exists(checksumPath))) return null;
  const expected = parseSha256File(await io.readFile(checksumPath));
  if (!expected) return null;
  if (verify) {
    const got = io.sha256(await io.readFile(redPath));
    if (got !== expected) return null;
  }
  return { redPath, checksumPath, assetName: redAssetName(key), sha256: expected };
}

export async function ensureRedBinary(
  io: RedRuntimeIO,
  input: EnsureRedBinaryInput,
): Promise<RedBinaryRuntime | null> {
  // Only the cold path (mayFetch) re-verifies, so a mismatch can re-fetch. The
  // hot path trusts the warm cache — see resolveCachedRedBinary.
  const cached = await resolveCachedRedBinary(io, input, { verify: input.mayFetch });
  if (cached) return cached;
  if (!input.mayFetch) return null;

  const key = input.platformKey ?? redPlatformKey();
  if (!key) throw new RedRuntimeError("no red binary for this platform");

  const repo = input.repo ?? REDDB_REPO;
  const releaseBase = input.releaseBase ?? RED_RELEASE_BASE;
  const assetName = redAssetName(key);
  const checksumPath = `${resolveRedBinaryPath(input.cacheDir, input.binaryTag, input.win32)}.sha256`;
  const shaBytes = await io.fetchBuffer(redAssetUrl(repo, input.binaryTag, `${assetName}.sha256`, releaseBase));
  const expected = parseSha256File(shaBytes);
  if (!expected) throw new RedRuntimeError(`missing sha256 for ${assetName}`);

  const redBytes = await io.fetchBuffer(redAssetUrl(repo, input.binaryTag, assetName, releaseBase));
  const got = io.sha256(redBytes);
  if (got !== expected) {
    throw new RedRuntimeError(`checksum mismatch for ${assetName}: ${got} != ${expected}`);
  }

  const redPath = resolveRedBinaryPath(input.cacheDir, input.binaryTag, input.win32);
  await io.writeFile(redPath, redBytes);
  await io.chmod(redPath, 0o755);
  await io.writeFile(checksumPath, new TextEncoder().encode(`${expected}  ${assetName}\n`));
  return { redPath, checksumPath, assetName, sha256: expected };
}

function stripLeadingV(tag: string): string {
  return tag.replace(/^v/, "");
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
