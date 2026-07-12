import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type RedRuntimeIO,
  ensureRedBinary,
  parseSha256File,
  redAssetUrl,
  redPlatformKey,
  resolveCachedRedBinary,
  resolveRedBinaryPath,
} from "./red-runtime.js";

const CACHE = "/cache/red-skills/bundles";
const TAG = "v1.7.0";
const KEY = "linux-x86_64";
const ASSET = "red-linux-x86_64";
const RED_BYTES = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function makeIO(opts: {
  files?: Record<string, Uint8Array>;
  responses?: Record<string, Uint8Array>;
}) {
  const files: Record<string, Uint8Array> = { ...(opts.files ?? {}) };
  const fetches: string[] = [];
  const writes: string[] = [];
  const chmods: Array<{ path: string; mode: number }> = [];
  const io: RedRuntimeIO = {
    async exists(path) {
      return path in files;
    },
    async readFile(path) {
      const body = files[path];
      if (!body) throw new Error(`ENOENT ${path}`);
      return body;
    },
    async writeFile(path, bytes) {
      writes.push(path);
      files[path] = bytes;
    },
    async chmod(path, mode) {
      chmods.push({ path, mode });
    },
    async fetchBuffer(url) {
      fetches.push(url);
      const body = opts.responses?.[url];
      if (!body) throw new Error(`GET ${url} -> 404`);
      return body;
    },
    sha256,
  };
  return { io, files, fetches, writes, chmods };
}

describe("red runtime resolver", () => {
  it("maps node platforms to reddb release asset keys", () => {
    expect(redPlatformKey("linux", "x64")).toBe("linux-x86_64");
    expect(redPlatformKey("darwin", "arm64")).toBe("macos-aarch64");
    expect(redPlatformKey("win32", "x64")).toBe("windows-x86_64");
    expect(redPlatformKey("sunos", "x64")).toBeNull();
  });

  it("parses the first sha256 token from checksum files", () => {
    expect(parseSha256File(`${sha256(RED_BYTES)}  ${ASSET}\n`)).toBe(sha256(RED_BYTES));
    expect(parseSha256File("not a checksum")).toBeNull();
  });

  it("resolves a warm cache without fetching", async () => {
    const redPath = resolveRedBinaryPath(CACHE, TAG);
    const { io, fetches } = makeIO({
      files: {
        [redPath]: RED_BYTES,
        [`${redPath}.sha256`]: new TextEncoder().encode(`${sha256(RED_BYTES)}  ${ASSET}\n`),
      },
    });

    const runtime = await ensureRedBinary(io, {
      cacheDir: CACHE,
      binaryTag: TAG,
      platformKey: KEY,
      mayFetch: false,
    });

    expect(runtime?.redPath).toBe(redPath);
    expect(fetches).toEqual([]);
  });

  it("returns null on a missing hot-path cache without fetching", async () => {
    const { io, fetches } = makeIO({});

    await expect(ensureRedBinary(io, {
      cacheDir: CACHE,
      binaryTag: TAG,
      platformKey: KEY,
      mayFetch: false,
    })).resolves.toBeNull();
    expect(fetches).toEqual([]);
  });

  it("fetches, checksum-verifies, writes, and chmods a cold binary", async () => {
    const checksumUrl = redAssetUrl("reddb-io/reddb", TAG, `${ASSET}.sha256`);
    const redUrl = redAssetUrl("reddb-io/reddb", TAG, ASSET);
    const { io, files, fetches, chmods } = makeIO({
      responses: {
        [checksumUrl]: new TextEncoder().encode(`${sha256(RED_BYTES)}  ${ASSET}\n`),
        [redUrl]: RED_BYTES,
      },
    });

    const runtime = await ensureRedBinary(io, {
      cacheDir: CACHE,
      binaryTag: TAG,
      platformKey: KEY,
      mayFetch: true,
    });

    expect(fetches).toEqual([checksumUrl, redUrl]);
    expect(files[runtime!.redPath]).toEqual(RED_BYTES);
    expect(files[runtime!.checksumPath]).toEqual(new TextEncoder().encode(`${sha256(RED_BYTES)}  ${ASSET}\n`));
    expect(chmods).toEqual([{ path: runtime!.redPath, mode: 0o755 }]);
  });

  it("refuses to adopt bytes that do not match the release checksum", async () => {
    const checksumUrl = redAssetUrl("reddb-io/reddb", TAG, `${ASSET}.sha256`);
    const redUrl = redAssetUrl("reddb-io/reddb", TAG, ASSET);
    const redPath = resolveRedBinaryPath(CACHE, TAG);
    const { io, files } = makeIO({
      responses: {
        [checksumUrl]: new TextEncoder().encode(`${sha256(new TextEncoder().encode("different"))}  ${ASSET}\n`),
        [redUrl]: RED_BYTES,
      },
    });

    await expect(ensureRedBinary(io, {
      cacheDir: CACHE,
      binaryTag: TAG,
      platformKey: KEY,
      mayFetch: true,
    })).rejects.toMatchObject({ name: "RedRuntimeError" });
    expect(files[redPath]).toBeUndefined();
  });

  it("treats a locally corrupted warm cache as unresolved", async () => {
    const redPath = resolveRedBinaryPath(CACHE, TAG);
    const { io } = makeIO({
      files: {
        [redPath]: new TextEncoder().encode("tampered"),
        [`${redPath}.sha256`]: new TextEncoder().encode(`${sha256(RED_BYTES)}  ${ASSET}\n`),
      },
    });

    await expect(resolveCachedRedBinary(io, {
      cacheDir: CACHE,
      binaryTag: TAG,
      platformKey: KEY,
    })).resolves.toBeNull();
  });
});
