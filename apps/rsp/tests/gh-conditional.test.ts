import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { readGhConditionalJson } from "../src/gh-conditional.js";
import { telemetrySpoolPath } from "../src/telemetry.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-gh-conditional-"));
  roots.push(root);
  await mkdir(join(root, ".red", "state", "rsp"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gh conditional requests", () => {
  it("serves repeated unchanged GETs from a 304-backed cached body and records quota-free telemetry", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    const countFile = join(root, "count");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `count_file=${shellQuote(countFile)}`,
      "count=0",
      "[ -f \"$count_file\" ] && count=\"$(cat \"$count_file\")\"",
      "next=$((count + 1))",
      "printf '%s' \"$next\" > \"$count_file\"",
      "if printf '%s\\n' \"$@\" | grep -q 'If-None-Match: rsp-test-etag'; then",
      "  printf 'HTTP/2 304 Not Modified\\r\\netag: rsp-test-etag\\r\\n\\r\\n'",
      "else",
      "  printf 'HTTP/2 200 OK\\r\\netag: rsp-test-etag\\r\\n\\r\\n{\"number\":1975,\"state\":\"OPEN\"}\\n'",
      "fi",
      "",
    ].join("\n"), "utf8");
    await chmod(join(bin, "gh"), 0o755);

    const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
    const first = await readGhConditionalJson({ path: "repos/owner/repo/issues/1975", cwd: root, telemetryRoot: root, env });
    const second = await readGhConditionalJson({ path: "repos/owner/repo/issues/1975", cwd: root, telemetryRoot: root, env });

    expect(first).toMatchObject({ status: 0, quotaFree: false });
    expect(second).toMatchObject({ status: 0, quotaFree: true });
    expect(second.stdout).toBe("{\"number\":1975,\"state\":\"OPEN\"}\n");
    expect(await readFile(countFile, "utf8")).toBe("2");
    const cacheRaw = await readFile(join(root, ".red", "state", "rsp", "gh-etag-cache.toon"), "utf8");
    expect(() => JSON.parse(cacheRaw)).toThrow();
    expect(decode(cacheRaw)).toMatchObject({ version: 1 });
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toContain("quota_free");
  });
});

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
