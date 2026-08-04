import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

const root = await mkdtemp(join(tmpdir(), "reddb-release-assets-"));
const manifest = join(root, "manifest.json");
let requests = 0;
let response = "ok";

const server = createServer((_request, reply) => {
  requests += 1;
  if (response === "drop") {
    _request.socket.destroy();
    return;
  }
  const status = response === "missing" ? 404 : 200;
  reply.writeHead(status).end();
});

before(async () => {
  await writeFile(manifest, JSON.stringify({
    reddb: {
      repo: "acme/reddb",
      tag: "v1.2.3",
      assets: { "linux-x86_64": { asset: "reddb-linux-x86_64.node" } },
    },
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

function verify(overrides = {}) {
  const address = server.address();
  assert(address && typeof address === "object");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/verify-reddb-release-assets.mjs", manifest], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REDDB_RELEASE_ASSET_BASE: `http://127.0.0.1:${address.port}`,
        REDDB_RELEASE_ASSET_RETRY_DELAY_MS: "1",
        REDDB_RELEASE_ASSET_ATTEMPTS: "3",
        ...overrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("a transport failure is retried and never called a missing asset", async () => {
  response = "drop";
  requests = 0;
  const result = await verify();

  assert.equal(result.code, 1);
  assert.equal(requests, 3);
  assert.match(result.stderr, /network never answered/i);
  assert.doesNotMatch(result.stderr, /missing reddb release asset/i);
});

test("a 404 is a missing asset verdict and is not retried", async () => {
  response = "missing";
  requests = 0;
  const result = await verify();

  assert.equal(result.code, 1);
  assert.equal(requests, 2, "one binary HEAD and one checksum HEAD");
  assert.match(result.stderr, /missing reddb release asset/);
});

