// ADR 0157: the native front is best-effort — every failure is an outcome with
// a reason, never a thrown install.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRIPTC_PINNED_VERSION,
  installStatuslineNativeFront,
  statuslineNativeFrontPath,
} from "../src/statusline-native.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratchHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "redskilled-native-"));
  roots.push(home);
  await mkdir(join(home, ".red", "redskilled"), { recursive: true });
  return home;
}

describe("installing the native statusline front", () => {
  it("skips with a stated reason on a host without clang", async () => {
    const result = await installStatuslineNativeFront({
      homeDir: await scratchHome(),
      run: async (command) => (command === "clang" ? { ok: false, detail: "not found" } : { ok: true }),
    });

    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("clang");
  });

  it("compiles through the pinned scriptc and leaves only the binary behind", async () => {
    const home = await scratchHome();
    const target = statuslineNativeFrontPath(home);
    const commands: string[][] = [];
    const result = await installStatuslineNativeFront({
      homeDir: home,
      run: async (command, args) => {
        commands.push([command, ...args]);
        if (command === "npx") await writeFile(target, "#!native\n", { mode: 0o755 });
        return { ok: true };
      },
    });

    expect(result.outcome).toBe("compiled");
    expect(existsSync(target)).toBe(true);
    // The compiler is pinned, never @latest (ADR 0157).
    const npx = commands.find(([command]) => command === "npx");
    expect(npx).toContain(`scriptc@${SCRIPTC_PINNED_VERSION}`);
    // The temporary source does not linger beside the binary.
    expect(existsSync(join(home, ".red", "redskilled", "bin", "statusline-fast.source.mts"))).toBe(false);
  });

  it("reports a failed compile as facts, with the compiler's own tail", async () => {
    const result = await installStatuslineNativeFront({
      homeDir: await scratchHome(),
      run: async (command) =>
        command === "clang" ? { ok: true } : { ok: false, detail: "error SC2020: no lowering" },
    });

    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("SC2020");
  });
});
