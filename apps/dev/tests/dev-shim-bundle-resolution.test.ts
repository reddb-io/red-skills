// The core package ships the `red-skills-dev` bin; ADR 0146 moved the bundle it
// execs into `@reddb-io/red-skills-dev`. A shim that looks only beside itself
// therefore finds nothing on a current install — 3.20.0 and 3.21.0 both publish
// a `dist/` without `dev.bundle.min.mjs`, and every Worker died on
// `packaged bundle missing` before it could claim a Ticket.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SHIM = join(import.meta.dirname, "..", "..", "..", "packaging", "npm", "bin", "red-skills-dev.mjs");

/** A node_modules tree with the core package, and optionally the plugin one. */
function install(options: { readonly local?: boolean; readonly plugin?: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "red-shim-"));
  const core = join(root, "node_modules", "@reddb-io", "red-skills");
  mkdirSync(join(core, "bin"), { recursive: true });
  writeFileSync(join(core, "package.json"), JSON.stringify({ name: "@reddb-io/red-skills", version: "0.0.0" }));
  writeFileSync(join(core, "bin", "red-skills-dev.mjs"), execFileSync("cat", [SHIM]));
  if (options.local === true) {
    mkdirSync(join(core, "dist"), { recursive: true });
    writeFileSync(join(core, "dist", "dev.bundle.min.mjs"), 'process.stdout.write("from-core\\n");');
  }
  if (options.plugin === true) {
    const plugin = join(root, "node_modules", "@reddb-io", "red-skills-dev");
    mkdirSync(join(plugin, "dist"), { recursive: true });
    writeFileSync(
      join(plugin, "package.json"),
      JSON.stringify({ name: "@reddb-io/red-skills-dev", version: "0.0.0", exports: { "./dist/*": "./dist/*" } }),
    );
    writeFileSync(join(plugin, "dist", "dev.bundle.min.mjs"), 'process.stdout.write("from-plugin\\n");');
  }
  return join(core, "bin", "red-skills-dev.mjs");
}

const run = (shim: string): { readonly out: string; readonly code: number } => {
  try {
    return { out: execFileSync(process.execPath, [shim], { encoding: "utf8" }), code: 0 };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { out: failure.stderr ?? "", code: failure.status ?? 1 };
  }
};

describe("the red-skills-dev shim finds the bundle wherever the package split left it", () => {
  it("execs the plugin package's bundle when the core package carries none", () => {
    expect(run(install({ plugin: true })).out).toContain("from-plugin");
  });

  it("still execs a bundle beside itself, so an older install keeps working", () => {
    expect(run(install({ local: true })).out).toContain("from-core");
  });

  it("names both locations and the install command when neither has it", () => {
    const { out, code } = run(install({}));
    expect(code).toBe(1);
    expect(out).toContain("@reddb-io/red-skills-dev/dist/dev.bundle.min.mjs");
    expect(out).toContain("npm i -g @reddb-io/red-skills-dev");
  });
});
