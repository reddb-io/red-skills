#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const manifestPath = process.argv[2] ?? "dist/memory-runtime-manifest.json";
const releaseBase = process.env.REDDB_RELEASE_ASSET_BASE ?? "https://github.com";
const timeoutMs = Number(process.env.REDDB_RELEASE_ASSET_TIMEOUT_MS ?? 15000);
const attempts = Math.max(1, Number(process.env.REDDB_RELEASE_ASSET_ATTEMPTS ?? 4));
const retryDelayMs = Math.max(0, Number(process.env.REDDB_RELEASE_ASSET_RETRY_DELAY_MS ?? 1000));

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

async function headAsset(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    if (response.status === 404) return { outcome: "absent", status: response.status };
    if (response.ok) return { outcome: "present", status: response.status };
    return { outcome: "http-error", status: response.status };
  } catch (error) {
    return { outcome: "unanswered", status: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function headAssetWithRetry(url) {
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await headAsset(url);
    if (result.outcome !== "unanswered") return { ...result, attempts: attempt };
    if (attempt < attempts) await delay(retryDelayMs * 2 ** (attempt - 1));
  }
  return { ...result, attempts };
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
  const result = await headAssetWithRetry(check.url);
  if (result.outcome === "present") {
    console.log(`ok ${check.platform} ${check.url}`);
  } else if (result.outcome === "absent") {
    fail(`missing reddb release asset for ${check.platform}: HEAD ${check.url} -> 404`);
  } else if (result.outcome === "unanswered") {
    fail(
      `could not verify reddb release asset for ${check.platform}: the network never answered HEAD ${check.url} ` +
        `after ${result.attempts} attempts -> ${result.status}`,
    );
    break;
  } else {
    fail(`reddb release asset check failed for ${check.platform}: HEAD ${check.url} -> HTTP ${result.status}`);
  }
}
