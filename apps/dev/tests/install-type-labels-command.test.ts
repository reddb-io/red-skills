import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ensureLabel = vi.fn(async () => undefined);

vi.mock("../src/runtime/gh.js", () => ({ ensureLabel }));

vi.mock("../src/runtime/wire.js", () => ({
  resolveRepoContext: vi.fn(async (root: string) => ({ root, repo: "acme/widgets" })),
}));

describe("installTypeLabelsCommand", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function seedRoot(configText: string | null): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "install-type-labels-"));
    roots.push(root);
    await mkdir(join(root, ".red"), { recursive: true });
    if (configText !== null) await writeFile(join(root, ".red", "config.yaml"), configText, "utf8");
    return root;
  }

  it("installs the shipped vocabulary and declares its HUMAN-ONLY half", async () => {
    const root = await seedRoot("plugins:\n  dev:\n    enabled: true\n");
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { installTypeLabelsCommand } = await import("../src/commands/install-type-labels.js");

    await expect(installTypeLabelsCommand(["--root", root], root)).resolves.toBe(0);

    const installed = ensureLabel.mock.calls.map((call) => (call as unknown as [unknown, string])[1]);
    expect(installed).toEqual([
      "wayfinder:research",
      "wayfinder:prototype",
      "wayfinder:grilling",
      "wayfinder:task",
    ]);
    const { parseConfigYaml } = await import("../src/core/config.js");
    const { declaredHitlTypeLabels } = await import("../src/core/hitl-type-declaration.js");
    const after = await readFile(join(root, ".red", "config.yaml"), "utf8");
    expect(declaredHitlTypeLabels(parseConfigYaml(after))).toEqual([
      "wayfinder:grilling",
      "wayfinder:prototype",
    ]);
    expect(writes.join("")).toContain("declared HUMAN-ONLY types: wayfinder:grilling, wayfinder:prototype");
    stdout.mockRestore();
  });

  it("marks the HUMAN-ONLY labels as such on the tracker itself", async () => {
    const root = await seedRoot("plugins:\n  dev:\n    enabled: true\n");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { installTypeLabelsCommand } = await import("../src/commands/install-type-labels.js");

    await expect(installTypeLabelsCommand(["--root", root, "wayfinder:grilling", "wayfinder:research"], root))
      .resolves.toBe(0);

    const calls = ensureLabel.mock.calls as unknown as [unknown, string, { description: string }][];
    expect(calls[0]?.[2].description).toContain("HUMAN-ONLY");
    expect(calls[1]?.[2].description).not.toContain("HUMAN-ONLY");
    stdout.mockRestore();
  });

  it("installs nothing when there is no .red/config.yaml to declare into", async () => {
    const root = await seedRoot(null);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const { installTypeLabelsCommand } = await import("../src/commands/install-type-labels.js");

    await expect(installTypeLabelsCommand(["--root", root], root)).resolves.toBe(1);

    expect(ensureLabel).not.toHaveBeenCalled();
    expect(writes.join("")).toContain("/red-setup");
    stdout.mockRestore();
  });
});
