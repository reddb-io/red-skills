/**
 * The body-versus-control cut, refused in both directions (issue #4015, ADR 0148).
 *
 * A Worker-side module left under the daemon fails, an undeclared body module
 * fails, and a control-plane authority reached for from the package fails.
 * The declaration lives in `../src/acp-body-control-cut.js`; this file only
 * pins it against the two live trees, so the inventory cannot drift into
 * fiction in either direction.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_DESPITE_THE_NAME,
  CONTROL_PLANE_SURFACES,
  WORKER_BODY_MODULES,
  definesSymbol,
  stripSourceComments,
} from "../src/acp-body-control-cut.js";

const repoRoot = join(__dirname, "..", "..", "..");
const daemonSource = join(repoRoot, "apps", "redskilled", "src");
const workerSource = join(repoRoot, "packages", "worker", "src");
const workerAcp = join(workerSource, "acp");

async function typescriptFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    found.push(join(entry.parentPath, entry.name));
  }
  return found;
}

async function sources(root: string): Promise<Map<string, string>> {
  const files = await typescriptFiles(root);
  const read = await Promise.all(files.map(async (path) => [path, await readFile(path, "utf8")] as const));
  return new Map(read);
}

describe("what runs inside the Worker lives in the package (#4015)", () => {
  it("finds every declared body module where the package says it is", async () => {
    const held = await readdir(workerAcp);

    for (const body of WORKER_BODY_MODULES) {
      expect(held, `${body.module} is declared body and is not in packages/worker/src/acp`)
        .toContain(body.module);
      const source = await readFile(join(workerAcp, body.module), "utf8");
      for (const name of body.defines) {
        expect(definesSymbol(source, name), `${body.module} no longer defines ${name}`).toBe(true);
      }
    }
  });

  it("declares every module under the package's ACP directory", async () => {
    const declared = new Set(["index.ts", ...WORKER_BODY_MODULES.map((body) => body.module)]);
    const undeclared = (await readdir(workerAcp))
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !declared.has(name));

    expect(undeclared, `undeclared Worker body modules: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("keeps no Worker-side module under the daemon's source tree", async () => {
    const daemon = await sources(daemonSource);
    const strays: string[] = [];

    for (const body of WORKER_BODY_MODULES) {
      if (body.formerDaemonModule == null) continue;
      for (const [path, source] of daemon) {
        if (path.endsWith(`${body.formerDaemonModule}`)) {
          strays.push(`${body.formerDaemonModule} is back under the daemon; it is body (${body.runs})`);
        }
        for (const name of body.defines) {
          if (definesSymbol(source, name)) {
            strays.push(`${path} defines ${name}; the daemon may re-export the body, never define it`);
          }
        }
      }
    }

    expect(strays, strays.join("\n")).toEqual([]);
  });

  it("still lets the daemon RE-EXPORT the body it re-execs into", async () => {
    const [controlPlane, cli] = await Promise.all([
      readFile(join(daemonSource, "acp-control-plane.ts"), "utf8"),
      readFile(join(daemonSource, "cli.ts"), "utf8"),
    ]);

    expect(controlPlane).toContain('export { runNativeAcpWorker } from "@reddb-io/worker/acp"');
    expect(cli).toContain('import { runAcpWorkerCommand } from "@reddb-io/worker/acp"');
  });
});

describe("whether, when and where a Worker exists stays with the daemon (#4015)", () => {
  it("finds every control-plane surface where the daemon says it is", async () => {
    for (const surface of CONTROL_PLANE_SURFACES) {
      for (const module of surface.modules) {
        expect(module.startsWith("apps/redskilled/src/"), `${surface.surface} left the daemon`).toBe(true);
      }
      const held = await Promise.all(
        surface.modules.map((module) => readFile(join(repoRoot, module), "utf8")),
      );
      for (const name of surface.defines) {
        expect(
          held.some((source) => definesSymbol(source, name)),
          `no ${surface.surface} module defines ${name}`,
        ).toBe(true);
      }
    }
  });

  it("keeps no control-plane module in the package", async () => {
    const body = await sources(workerSource);
    const crossings: string[] = [];

    for (const surface of CONTROL_PLANE_SURFACES) {
      for (const [path, source] of body) {
        for (const name of surface.defines) {
          if (definesSymbol(source, name)) {
            crossings.push(`${path} defines ${name} (${surface.surface}): ${surface.why}`);
          }
        }
      }
    }

    expect(crossings, crossings.join("\n")).toEqual([]);
  });

  it("keeps the two modules the name would have moved", async () => {
    for (const held of CONTROL_PLANE_DESPITE_THE_NAME) {
      const source = await readFile(join(daemonSource, held.module), "utf8");
      for (const name of held.defines) {
        expect(definesSymbol(source, name), `${held.module} no longer defines ${name}`).toBe(true);
      }
      expect(
        WORKER_BODY_MODULES.some((body) => body.formerDaemonModule === held.module),
        `${held.module} is claimed as body and as control at once`,
      ).toBe(false);
    }
  });

  it("never lets the package import the daemon", async () => {
    const body = await sources(workerSource);
    const reaches: string[] = [];

    for (const [path, source] of body) {
      const code = stripSourceComments(source);
      if (/from\s+["'][^"']*apps\/redskilled/.test(code) || /from\s+["']@reddb-io\/redskilled/.test(code)) {
        reaches.push(`${path} imports the daemon; the body is imported BY it, never the other way`);
      }
    }

    expect(reaches, reaches.join("\n")).toEqual([]);
  });

  it("scanned both trees — a walker that reaches nothing is green by accident", async () => {
    expect((await typescriptFiles(daemonSource)).length).toBeGreaterThan(50);
    expect((await typescriptFiles(workerSource)).length).toBeGreaterThan(50);
  });
});

describe("the cut is written down where the package is read (#4015)", () => {
  it("states the rule, both halves, in the package README", async () => {
    const readme = await readFile(join(repoRoot, "packages", "worker", "README.md"), "utf8");

    expect(readme).toContain("What runs inside the Worker is the body");
    expect(readme).toContain("Whether, when and where a Worker exists is the control plane");
    for (const surface of CONTROL_PLANE_SURFACES) {
      expect(readme, `the README never names ${surface.surface} as control plane`)
        .toContain(surface.surface);
    }
  });
});
