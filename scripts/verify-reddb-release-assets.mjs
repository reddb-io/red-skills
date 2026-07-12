#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const manifestPath = process.argv[2] ?? "dist/memory-runtime-manifest.json";
const releaseBase = process.env.REDDB_RELEASE_ASSET_BASE ?? "https://github.com";
const timeoutMs = Number(process.env.REDDB_RELEASE_ASSET_TIMEOUT_MS ?? 15000);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function assetUrl(repo, tag, asset) {
  return `${releaseBase.replace(/\/+$/, "")}/${repo}/releases/download/${tag}/${asset}`;
}

function readReddbManifest(manifest) {
  const reddb = manifest?.reddb;
  if (!reddb || typeof reddb !== "object") {
    throw new Error("runtime manifest is missing reddb metadata");
  }
  if (typeof reddb.repo !== "string" || !reddb.repo) {
    throw new Error("runtime manifest is missing reddb.repo");
  }
  if (typeof reddb.tag !== "string" || !reddb.tag) {
    throw new Error("runtime manifest is missing reddb.tag");
  }
  if (!reddb.assets || typeof reddb.assets !== "object") {
    throw new Error("runtime manifest is missing reddb.assets");
  }
  return reddb;
}

async function headOk(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const reddb = readReddbManifest(manifest);
const checks = [];

for (const [platform, entry] of Object.entries(reddb.assets)) {
  if (!entry || typeof entry !== "object" || typeof entry.asset !== "string" || !entry.asset) {
    throw new Error(`runtime manifest has invalid asset entry for ${platform}`);
  }
  checks.push({ platform, url: assetUrl(reddb.repo, reddb.tag, entry.asset) });
  checks.push({ platform, url: assetUrl(reddb.repo, reddb.tag, `${entry.asset}.sha256`) });
}

if (checks.length === 0) {
  throw new Error("runtime manifest contains no reddb release assets");
}

for (const check of checks) {
  const result = await headOk(check.url);
  if (result.ok) {
    console.log(`ok ${check.platform} ${check.url}`);
  } else {
    fail(`missing reddb release asset for ${check.platform}: HEAD ${check.url} -> ${result.status}`);
  }
}
