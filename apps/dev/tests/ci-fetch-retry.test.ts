import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCRIPT = join(ROOT, "scripts/ci-fetch-with-retry.sh");

type Run = { code: number; stderr: string };

/**
 * Runs the fetcher with a tight retry budget so a test never pays the real
 * CI backoff. The defaults live in the script; only the pacing is overridden.
 */
async function fetchWithRetry(args: string[], attempts = 3): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(SCRIPT, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        CI_FETCH_ATTEMPTS: String(attempts),
        CI_FETCH_INITIAL_DELAY_S: "0",
        CI_FETCH_MAX_TIME_S: "10",
      },
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function readWorkflow(name: string): Promise<string> {
  return readFile(join(ROOT, ".github/workflows", name), "utf8");
}

function stepBody(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  expect(start, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);

  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

const servers: Server[] = [];
const tempDirs: string[] = [];

async function serve(handler: (hits: number) => { status: number; body: string }): Promise<string> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    const { status, body } = handler(hits);
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  });
  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}/install.sh`;
}

async function outputPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ci-fetch-"));
  tempDirs.push(dir);
  return join(dir, "downloaded");
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ci-fetch-with-retry", () => {
  it("retries a 403 and succeeds, because curl's own --retry never covers 403", async () => {
    // The exact outage this exists for: a single transient
    // `curl: (22) The requested URL returned error: 403` failed a whole job.
    // curl --retry only reschedules 408/429/5xx, so the blip was never retried.
    const url = await serve((hits) =>
      hits < 3 ? { status: 403, body: "rate limited" } : { status: 200, body: "#!/bin/sh\necho ok\n" },
    );
    const output = await outputPath();

    const run = await fetchWithRetry([url, output]);

    expect(run.code, run.stderr).toBe(0);
    expect(await readFile(output, "utf8")).toContain("echo ok");
  });

  it("names the URL and the HTTP status when every attempt is refused", async () => {
    const url = await serve(() => ({ status: 403, body: "forbidden" }));
    const output = await outputPath();

    const run = await fetchWithRetry([url, output]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(url);
    expect(run.stderr).toContain("403");
    // "wrong", not "unreachable": the server answered.
    expect(run.stderr).toContain("answered with HTTP 403");
  });

  it("reports an unreachable host as unreachable rather than as a status", async () => {
    // Nothing is listening on this port, so there is no HTTP status at all.
    const output = await outputPath();

    const run = await fetchWithRetry(["http://127.0.0.1:1/install.sh", output]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("unreachable");
    expect(run.stderr).not.toContain("answered with HTTP");
  });

  it("leaves no partial body behind when the fetch fails", async () => {
    const url = await serve(() => ({ status: 500, body: "half a script" }));
    const output = await outputPath();

    const run = await fetchWithRetry([url, output]);

    expect(run.code).toBe(1);
    expect(existsSync(output)).toBe(false);
  });

  it("makes every attempt, so a late recovery still lands", async () => {
    const url = await serve((hits) => (hits < 5 ? { status: 502, body: "" } : { status: 200, body: "late" }));
    const output = await outputPath();

    const run = await fetchWithRetry([url, output], 5);

    expect(run.code, run.stderr).toBe(0);
    expect(await readFile(output, "utf8")).toBe("late");
  });
});

describe("CI setup network fetches", () => {
  it("installs workspace-CI tq from the pinned official crate", async () => {
    const step = stepBody(await readWorkflow("red-workspace-ci.yml"), "Install pinned tq");

    expect(step).toContain('cargo install reddb-io-tq --version "${TQ_VERSION#v}" --locked');
    expect(step).toContain('tq_root="$RUNNER_TEMP/tq"');
    expect(step).not.toContain("../toon");
    expect(step).not.toContain("curl ");
  });

  it("installs benchmark-CI tq from the pinned official crate", async () => {
    const step = stepBody(await readWorkflow("red-rsp-benchmark-ci.yml"), "Install pinned tq");

    expect(step).toContain('cargo install reddb-io-tq --version "${TQ_VERSION#v}" --locked');
    expect(step).toContain('"$tq_root/bin/tq" --version');
    expect(step).not.toContain("../toon");
    expect(step).not.toContain("curl ");
  });

  it("routes the red binary install through the shared fetcher too, not a special case", async () => {
    const action = await readFile(join(ROOT, ".github/actions/install-red-binary/action.yml"), "utf8");

    expect(action).toContain("ci-fetch-with-retry.sh");
    expect(action).not.toContain("curl -fsSL");
  });

  it("leaves no un-retried curl anywhere in CI setup", async () => {
    const surfaces = [
      ".github/workflows/red-workspace-ci.yml",
      ".github/workflows/red-rsp-benchmark-ci.yml",
      ".github/actions/install-red-binary/action.yml",
    ];

    for (const surface of surfaces) {
      const body = await readFile(join(ROOT, surface), "utf8");
      expect(body, `${surface} still fetches with a bare curl`).not.toMatch(/^\s*curl\b/m);
    }
  });
});

describe("CI narrowed typecheck job", () => {
  it.each(["Test bundle-app contract", "Test generate-manifests contract"])(
    "does not run %s when the scope skipped checkout (#3495)",
    async (name) => {
      const step = stepBody(await readWorkflow("red-workspace-ci.yml"), name);

      expect(step).toContain("if: env.RUN_ANY == 'true'");
    },
  );
});
