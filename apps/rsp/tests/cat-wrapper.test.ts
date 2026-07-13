import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { RspElisionStore } from "../src/elision-store.js";
import { renderCatContract, runCatWrapper } from "../src/cat-wrapper.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-cat-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp cat wrapper", () => {
  it("renders code files as deterministic outline TOON with a reversible lossy handle", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "store.rdb")}` });
    const source = [
      "export interface User {",
      "  id: string;",
      "}",
      "",
      "export async function loadUser(id: string): Promise<User> {",
      "  return { id };",
      "}",
      "",
      "class UserCache {",
      "  get(id: string): User {",
      "    return { id };",
      "  }",
      "}",
      "",
    ].join("\n");

    try {
      const result = await renderCatContract(["cat", "src/user.ts"], {
        stdout: source,
        stderr: "",
        status: 0,
        signal: null,
      }, { level: "terse", store });

      expect(result.status).toBe(0);
      expect(result.mintedHandle).toMatch(/^el:[a-f0-9]{12}$/);
      expect(result.bytesElided).toBe(Buffer.byteLength(source));
      const text = result.stdout.toString("utf8");
      expect(text).toContain("rsp show el:");
      const decoded = decode(text.split("\n").filter((line) => !line.startsWith("… elided ")).join("\n"));
      expect(decoded).toMatchObject({
        command: "cat src/user.ts",
        file: "src/user.ts",
        kind: "code",
        outline_source: "regex",
        symbols: [
          { kind: "interface", name: "User", line: 1 },
          { kind: "function", name: "loadUser", line: 5 },
          { kind: "class", name: "UserCache", line: 9 },
          { kind: "method", name: "get", line: 10 },
        ],
      });

      const recovered = await store.get(result.mintedHandle!);
      if (!recovered || !("original" in recovered) || !recovered.original) throw new Error("missing recovered original");
      expect(recovered.original.toString("utf8")).toBe(source);
    } finally {
      await store.close();
    }
  });

  it("passes binary files through byte-for-byte", async () => {
    const root = await tempRoot();
    const path = join(root, "blob.bin");
    const bytes = Buffer.from([0, 1, 2, 255, 10, 0]);
    await writeFile(path, bytes);

    const result = await runCatWrapper(["cat", path], { level: "terse" });

    expect(result.stdout).toEqual(bytes);
    expect(result.mintedHandle).toBeUndefined();
    expect(result.bytesElided).toBeUndefined();
  });

  it("renders text head/tail slices with original-byte recovery", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "store.rdb")}` });
    const path = join(root, "notes.md");
    const text = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    await writeFile(path, text, "utf8");

    try {
      const result = await runCatWrapper(["cat", "--head", "3", path], { level: "brief", store });
      const out = result.stdout.toString("utf8");
      expect(out).toContain("kind: text");
      expect(out).toContain("line 1");
      expect(out).toContain("line 3");
      expect(out).not.toContain("line 4");
      expect(out).toContain("rsp show el:");
      const recovered = await store.get(result.mintedHandle!);
      if (!recovered || !("original" in recovered) || !recovered.original) throw new Error("missing recovered original");
      expect(recovered.original.toString("utf8")).toBe(text);
    } finally {
      await store.close();
    }
  });
});
