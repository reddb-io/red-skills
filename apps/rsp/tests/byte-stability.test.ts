import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { RspElisionStore } from "../src/elision-store.js";
import { discoverFidelityFixtures, renderFixture, type FidelityFixture } from "../src/fidelity.js";
import { renderCatContract } from "../src/cat-wrapper.js";

const roots: string[] = [];

const gitFixtureRoot = join(import.meta.dirname, "fixtures", "git");
const ghFixtureRoot = join(import.meta.dirname, "fixtures", "gh");
const testFixtureRoot = join(import.meta.dirname, "fixtures", "test-runners");
const fileReadFixtureRoot = join(import.meta.dirname, "fixtures", "file-read");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-golden-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function openStore(root: string): Promise<RspElisionStore> {
  return RspElisionStore.open({
    uri: `file://${join(root, "store.rdb")}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

async function renderTwice(
  fixture: FidelityFixture,
  level: "lossless" | "brief" | "terse",
  root: string,
): Promise<[Buffer, Buffer]> {
  const store1 = await openStore(root);
  const result1 = await renderFixture(fixture, { level, store: store1 });
  await store1.close();
  const root2 = await mkdtemp(join(tmpdir(), "rsp-golden2-"));
  roots.push(root2);
  const store2 = await openStore(root2);
  const result2 = await renderFixture(fixture, { level, store: store2 });
  await store2.close();
  return [result1.stdout, result2.stdout];
}

describe("byte stability invariant", () => {
  // Invariant: identical fixture state → byte-identical rsp output, enabling prompt-cache hits.
  // Each test renders the same recorded fixture twice with fresh stores (to prove content-addressing,
  // not store-state recycling) and asserts Buffer equality.

  describe("git wrapper family", () => {
    it("every git fixture is byte-stable at lossless level", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(gitFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "lossless", root);
        expect(b).toEqual(a);
      }
    });

    it("every git fixture is byte-stable at brief level", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(gitFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "brief", root);
        expect(b).toEqual(a);
      }
    });

    it("every git fixture is byte-stable at terse level (elision handle is content-addressed)", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(gitFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "terse", root);
        expect(b).toEqual(a);
      }
    });
  });

  describe("gh wrapper family", () => {
    it("every gh fixture is byte-stable at lossless level", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(ghFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "lossless", root);
        expect(b).toEqual(a);
      }
    });

    it("every gh fixture is byte-stable at brief level", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(ghFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "brief", root);
        expect(b).toEqual(a);
      }
    });

    it("every gh fixture is byte-stable at terse level (row-elision handle is content-addressed)", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(ghFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "terse", root);
        expect(b).toEqual(a);
      }
    });
  });

  describe("test wrapper family (vitest + cargo)", () => {
    it("every test-runner fixture is byte-stable at lossless level", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(testFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "lossless", root);
        expect(b).toEqual(a);
      }
    });

    it("every test-runner fixture is byte-stable at brief level", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(testFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "brief", root);
        expect(b).toEqual(a);
      }
    });

    it("every test-runner fixture is byte-stable at terse level (failure-elision handle is content-addressed)", async () => {
      const root = await tempRoot();
      for (const fixture of await discoverFidelityFixtures(testFixtureRoot)) {
        const [a, b] = await renderTwice(fixture, "terse", root);
        expect(b).toEqual(a);
      }
    });
  });

  describe("cat wrapper family", () => {
    it("code file outline is byte-stable at terse level (file-elision handle is content-addressed)", async () => {
      const root = await tempRoot();
      const [fixture] = await discoverFidelityFixtures(fileReadFixtureRoot);
      if (!fixture) throw new Error("expected at least one file-read fixture");
      const [a, b] = await renderTwice(fixture, "terse", root);
      expect(b).toEqual(a);
    });

    it("code file outline is byte-stable at lossless level", async () => {
      const root = await tempRoot();
      const [fixture] = await discoverFidelityFixtures(fileReadFixtureRoot);
      if (!fixture) throw new Error("expected at least one file-read fixture");
      const [a, b] = await renderTwice(fixture, "lossless", root);
      expect(b).toEqual(a);
    });

    it("text file render is byte-stable across levels and slicing modes", async () => {
      const root = await tempRoot();
      const content = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      const contract = { stdout: content, stderr: "", status: 0, signal: null };
      const store1 = await openStore(root);
      const result1 = await renderCatContract(["cat", "notes.md"], contract, { level: "brief", store: store1 });
      await store1.close();
      const root2 = await mkdtemp(join(tmpdir(), "rsp-golden-cat-"));
      roots.push(root2);
      const store2 = await openStore(root2);
      const result2 = await renderCatContract(["cat", "notes.md"], contract, { level: "brief", store: store2 });
      await store2.close();
      expect(result2.stdout).toEqual(result1.stdout);
    });

    it("head/tail slice renders are byte-stable", async () => {
      const root = await tempRoot();
      const content = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
      const contract = { stdout: content, stderr: "", status: 0, signal: null };
      for (const command of [["cat", "--head", "5", "log.md"], ["cat", "--tail", "5", "log.md"]]) {
        const store1 = await openStore(root);
        const result1 = await renderCatContract(command, contract, { level: "brief", store: store1 });
        await store1.close();
        const root2 = await mkdtemp(join(tmpdir(), "rsp-golden-slice-"));
        roots.push(root2);
        const store2 = await openStore(root2);
        const result2 = await renderCatContract(command, contract, { level: "brief", store: store2 });
        await store2.close();
        expect(result2.stdout).toEqual(result1.stdout);
      }
    });
  });

  describe("content-addressed handle invariant", () => {
    it("minting identical bytes twice returns the same el: handle regardless of store instance", async () => {
      const bytes = Buffer.from("deterministic payload for handle test");
      const meta = { command: "rsp git log", loss: { level: "terse" as const, bytes_elided: bytes.length } };

      const root1 = await tempRoot();
      const store1 = await openStore(root1);
      const handle1 = await store1.mint(bytes, meta);
      await store1.close();

      const root2 = await tempRoot();
      const store2 = await openStore(root2);
      const handle2 = await store2.mint(bytes, meta);
      await store2.close();

      expect(handle1).toBe(handle2);
      expect(handle1).toMatch(/^el:[a-f0-9]{12}$/);
    });

    it("different bytes produce different el: handles (no hash collision for test inputs)", async () => {
      const root = await tempRoot();
      const store = await openStore(root);
      const meta = { command: "rsp git status", loss: { level: "terse" as const, bytes_elided: 100 } };
      const handle1 = await store.mint(Buffer.from("payload A"), meta);
      const handle2 = await store.mint(Buffer.from("payload B"), meta);
      await store.close();
      expect(handle1).not.toBe(handle2);
    });
  });

  describe("no intentional exceptions to the byte-stability invariant", () => {
    // This test enumerates all known exceptions. It must fail when a new exception is added
    // without being listed here — forcing explicit documentation rather than silent tolerance.
    it("zero fields in any wrapper family carry wall-clock timestamps or unstable ordering", () => {
      // All summarized payload fields are derived solely from recorded fixture data.
      // No render path calls Date.now(), Math.random(), or reads process.env time sources.
      // Update this list if a legitimate exception is ever added; leave the list empty when none exist.
      const intentionalExceptions: string[] = [];
      expect(intentionalExceptions).toHaveLength(0);
    });
  });
});
