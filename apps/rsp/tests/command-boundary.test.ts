import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { measureStructuredBoundary } from "../src/command-boundary-benchmark.js";
import { buildBundleOnce, bundle } from "./cli.helpers.js";

const roots: string[] = [];

beforeAll(() => buildBundleOnce());

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-command-boundary-"));
  roots.push(root);
  return root;
}

function rsp(cwd: string, argv: readonly string[]) {
  return spawnSync(process.execPath, [bundle, ...argv], { cwd, encoding: "buffer" });
}

function shell(cwd: string, command: string) {
  return spawnSync(command, { cwd, shell: true, encoding: "buffer" });
}

describe("rsp universal command boundary", () => {
  it("transcodes only completed agent-facing stdout while pipelines receive native bytes", async () => {
    const root = await tempRoot();
    const direct = rsp(root, [process.execPath, "-e", "process.stdout.write(JSON.stringify({service:'api',nested:{ok:true}}))"]);

    expect(direct.status).toBe(0);
    expect((await import("@reddb-io/toon")).decode(direct.stdout.toString("utf8"))).toEqual({
      service: "api",
      nested: { ok: true },
    });

    const pipeline = [
      `printf '%s' '{"stage":"native"}'`,
      `${process.execPath} -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>process.stdout.write(JSON.stringify({received:JSON.parse(input),stage:"agent"})))'`,
    ].join(" | ");
    const proxied = rsp(root, ["proxy", "--", pipeline]);

    expect(proxied.status).toBe(0);
    expect((await import("@reddb-io/toon")).decode(proxied.stdout.toString("utf8"))).toEqual({
      received: { stage: "native" },
      stage: "agent",
    });

    await mkdir(join(root, ".red"));
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await writeFile(join(root, "native.json"), '{"source":"cat"}', "utf8");
    const specializedPipeline = [
      "cat native.json",
      `${process.execPath} -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>process.stdout.write(JSON.stringify({received:JSON.parse(input),stage:"agent"})))'`,
    ].join(" | ");
    const specialized = rsp(root, ["proxy", "--", specializedPipeline]);

    expect(specialized.status).toBe(0);
    expect((await import("@reddb-io/toon")).decode(specialized.stdout.toString("utf8"))).toEqual({
      received: { source: "cat" },
      stage: "agent",
    });
  });

  it("preserves stderr and non-zero exit status when structured stdout is transformed", async () => {
    const root = await tempRoot();
    const result = rsp(root, [process.execPath, "-e", "process.stdout.write('{\"ok\":false}');process.stderr.write('native error\\n');process.exit(29)"]);

    expect((await import("@reddb-io/toon")).decode(result.stdout.toString("utf8"))).toEqual({ ok: false });
    expect(result.stderr).toEqual(Buffer.from("native error\n"));
    expect(result.status).toBe(29);
  });

  it("preserves direct argv, Unicode, stream bytes, empty output, binary output, and non-zero exits", async () => {
    const root = await tempRoot();
    const script = [
      "const [spaced, unicode, mode] = process.argv.slice(1);",
      "if (mode === 'binary') process.stdout.write(Buffer.from([0, 255, 10, 13]));",
      "else if (mode === 'empty') process.exit(0);",
      "else { process.stdout.write(spaced + '\\0' + unicode); process.stderr.write('stderr\\0bytes'); process.exit(23); }",
    ].join("");

    const ordinary = rsp(root, [process.execPath, "-e", script, "two words 'quoted'", "Olá 世界", "ordinary"]);
    expect(ordinary.stdout).toEqual(Buffer.from("two words 'quoted'\0Olá 世界"));
    expect(ordinary.stderr).toEqual(Buffer.from("stderr\0bytes"));
    expect(ordinary.status).toBe(23);

    const empty = rsp(root, [process.execPath, "-e", script, "", "", "empty"]);
    expect(empty.stdout).toEqual(Buffer.alloc(0));
    expect(empty.stderr).toEqual(Buffer.alloc(0));
    expect(empty.status).toBe(0);

    const binary = rsp(root, [process.execPath, "-e", script, "", "", "binary"]);
    expect(binary.stdout).toEqual(Buffer.from([0, 255, 10, 13]));
    expect(binary.stderr).toEqual(Buffer.alloc(0));
    expect(binary.status).toBe(0);
  });

  it("preserves direct-command termination signals", async () => {
    const root = await tempRoot();
    const result = rsp(root, [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it.each([
    ["quotes", "printf '%s\\n' 'two words' 'Olá 世界'"],
    ["redirects", "printf 'saved\\n' > saved.txt && cat < saved.txt"],
    ["pipelines", "printf 'one\\ntwo\\n' | sed -n '2p'"],
    ["stderr and exit", "printf 'out\\n'; printf 'err\\n' >&2; exit 17"],
    ["merged stream ordering", "{ printf 'out\\n'; printf 'err\\n' >&2; printf 'tail\\n'; } 2>&1"],
    ["empty", ":"],
    ["malformed syntax", "printf 'unterminated"],
  ])("uses the original shell for %s", async (_label, command) => {
    const rawRoot = await tempRoot();
    const rspRoot = await tempRoot();
    const raw = shell(rawRoot, command);
    const proxied = rsp(rspRoot, ["proxy", "--", command]);

    expect(proxied.stdout).toEqual(raw.stdout);
    expect(proxied.stderr).toEqual(raw.stderr);
    expect(proxied.status).toBe(raw.status);
    expect(proxied.signal).toBe(raw.signal);
  });

  it("keeps unsupported mixed compounds on exact shell passthrough with native && short-circuiting", async () => {
    const rawRoot = await tempRoot();
    const rspRoot = await tempRoot();
    for (const root of [rawRoot, rspRoot]) {
      const initialized = shell(root, "git init -q && git config user.email rsp@example.invalid && git config user.name RSP && printf tracked > tracked.txt && git add tracked.txt && git commit -qm initial");
      expect(initialized.status, initialized.stderr.toString("utf8")).toBe(0);
    }
    const diagnostic = "cargo --version >/dev/null 2>&1 || true; rustc --version >/dev/null 2>&1 || true; find . -maxdepth 1 -type f -print0 | xargs -0 du -b | sort -n | tail -n 1 > diagnostic.txt && false && printf never";
    const release = "git show --format=%s --no-patch HEAD > release.txt && git fetch invalid-remote && git switch main && git merge topic && git branch -d topic";

    for (const command of [diagnostic, release]) {
      const raw = shell(rawRoot, command);
      const proxied = rsp(rspRoot, ["proxy", "--", command]);
      expect(proxied.stdout).toEqual(raw.stdout);
      expect(proxied.stderr).toEqual(raw.stderr);
      expect(proxied.status).toBe(raw.status);
      expect(proxied.signal).toBe(raw.signal);
    }
    await expect(readFile(join(rspRoot, "diagnostic.txt"))).resolves.toEqual(await readFile(join(rawRoot, "diagnostic.txt")));
    await expect(readFile(join(rspRoot, "release.txt"))).resolves.toEqual(await readFile(join(rawRoot, "release.txt")));
  });

  it("loads the same-version core beside a versioned cache launcher", async () => {
    const root = await tempRoot();
    const launcher = join(root, "rsp-9.9.9.bundle.min.mjs");
    await copyFile(bundle, launcher);
    await copyFile(join(dirname(bundle), "rsp-core.bundle.min.mjs"), join(root, "rsp-core-9.9.9.bundle.min.mjs"));

    const result = spawnSync(process.execPath, [launcher, "--help"], { cwd: root, encoding: "buffer" });
    expect(result.status, `${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`).toBe(0);
    expect(result.stdout.toString("utf8")).toContain("usage: rsp <subcommand> [options]");
    expect(result.stderr).toEqual(Buffer.alloc(0));
  });

  it("runs simple passthrough with an unavailable resident and creates no state", async () => {
    const root = await tempRoot();
    const result = rsp(root, [process.execPath, "-e", "process.stdout.write('resident-free')"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(Buffer.from("resident-free"));
    expect(result.stderr).toEqual(Buffer.alloc(0));
    expect(await readdir(root)).toEqual([]);
  });

  it("keeps p95 passthrough overhead at 50ms and cold invocation at 200ms on the reference boundary", async () => {
    const root = await tempRoot();
    const samples: Array<{ raw: number; rsp: number }> = [];
    const timed = (argv: readonly string[]) => {
      const started = process.hrtime.bigint();
      const result = spawnSync(argv[0]!, argv.slice(1), { cwd: root, stdio: "ignore" });
      return { result, ms: Number(process.hrtime.bigint() - started) / 1_000_000 };
    };

    const cold = timed([process.execPath, bundle, process.execPath, "-e", ""]);
    expect(cold.result.status).toBe(0);
    expect(cold.ms).toBeLessThanOrEqual(200);

    for (let index = 0; index < 20; index += 1) {
      const raw = timed([process.execPath, "-e", ""]);
      const wrapped = timed([process.execPath, bundle, process.execPath, "-e", ""]);
      expect(raw.result.status).toBe(0);
      expect(wrapped.result.status).toBe(0);
      samples.push({ raw: raw.ms, rsp: wrapped.ms });
    }
    const percentile = (values: number[], fraction: number) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
    const p95Overhead = Math.max(
      0,
      percentile(samples.map((sample) => sample.rsp), 0.95) -
        percentile(samples.map((sample) => sample.raw), 0.95),
    );
    expect(p95Overhead).toBeLessThanOrEqual(50);
  }, 30_000);

  it("keeps p95 structured transformation at or below 100ms on the reference boundary", () => {
    const measurement = measureStructuredBoundary(40);

    expect(measurement.samples).toBe(40);
    expect(measurement.p95_ms).toBeLessThanOrEqual(100);
  });

  it("keeps explicit wrappers on the same boundary", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "note.txt"), "wrapped cat\n", "utf8");
    const result = rsp(root, ["cat", "note.txt"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toEqual(Buffer.from("wrapped cat\n"));
    expect(result.stderr).toEqual(Buffer.alloc(0));
  });
});
