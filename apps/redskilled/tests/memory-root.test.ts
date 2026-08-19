import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkoutMemoryRoot,
  projectMemoryRoot,
  readCheckoutMemoryOptIn,
  resolveProjectMemoryRoot,
} from "../src/memory-root.js";
import { projectDirectoryName } from "../src/project-workspace.js";

const PROJECT_ID = "github:987654";

async function checkout(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-memory-root-"));
  if (config != null) {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), config, "utf8");
  }
  return root;
}

const OPTED_IN = "plugins:\n  memory:\n    enabled: true\n    store: checkout\n";

// Acceptance criterion of #4027: the default is the Project's own store, the
// opt-in reaches the checkout only for a human, and a Worker never does.
describe("where a memory call lands (ADR 0152)", () => {
  it("defaults to ~/.red/memory/<project-id> when the repository did not opt in", async () => {
    const root = await checkout("plugins:\n  memory:\n    enabled: true\n");
    const resolved = await resolveProjectMemoryRoot({
      projectId: PROJECT_ID,
      checkoutRoot: root,
      home: "/home/operator",
    });
    expect(resolved.scope).toBe("project");
    expect(resolved.root).toBe(
      join("/home/operator", ".red", "memory", projectDirectoryName(PROJECT_ID)),
    );
  });

  it("defaults to the Project store when the checkout carries no config at all", async () => {
    const root = await checkout();
    const resolved = await resolveProjectMemoryRoot({
      projectId: PROJECT_ID,
      checkoutRoot: root,
      home: "/home/operator",
    });
    expect(resolved.scope).toBe("project");
    expect(resolved.root).toBe(projectMemoryRoot("/home/operator", PROJECT_ID));
  });

  it("reaches the checkout when the repository opted in and the caller exports no RED_MODE", async () => {
    const root = await checkout(OPTED_IN);
    const resolved = await resolveProjectMemoryRoot({
      projectId: PROJECT_ID,
      checkoutRoot: root,
      home: "/home/operator",
    });
    expect(resolved.scope).toBe("checkout");
    expect(resolved.root).toBe(checkoutMemoryRoot(root));
  });

  it("reaches the checkout for the two modes a human is standing in one for", async () => {
    const root = await checkout(OPTED_IN);
    for (const mode of ["interactive", "ADR-editing"] as const) {
      const resolved = await resolveProjectMemoryRoot({
        projectId: PROJECT_ID,
        checkoutRoot: root,
        home: "/home/operator",
        mode,
      });
      expect(resolved.scope, mode).toBe("checkout");
    }
  });

  // The strongest half of the criterion: not "prefers the Project store" but
  // "never opens the checkout" — including the opt-in that would authorise it.
  it("never opens the checkout when RED_MODE names a Worker's mode", async () => {
    const root = await checkout(OPTED_IN);
    const touched: string[] = [];
    for (const mode of ["spec-driven", "ad-hoc"] as const) {
      const resolved = await resolveProjectMemoryRoot({
        projectId: PROJECT_ID,
        checkoutRoot: root,
        home: "/home/operator",
        mode,
        readCheckoutOptIn: async (path) => {
          touched.push(path);
          return true;
        },
      });
      expect(resolved.scope, mode).toBe("project");
      expect(resolved.root, mode).toBe(projectMemoryRoot("/home/operator", PROJECT_ID));
      expect(resolved.root.startsWith(root), mode).toBe(false);
    }
    expect(touched, "a Worker's call read the human checkout's opt-in").toEqual([]);
  });
});

describe("the checkout opt-in is strict (ADR 0067's posture)", () => {
  it("reads `plugins.memory.store: checkout` as the one way to opt in", async () => {
    expect(await readCheckoutMemoryOptIn(await checkout(OPTED_IN))).toBe(true);
  });

  it("reads absence, another value and malformed YAML as off", async () => {
    expect(await readCheckoutMemoryOptIn(await checkout())).toBe(false);
    expect(await readCheckoutMemoryOptIn(await checkout("plugins:\n  memory:\n    store: project\n")))
      .toBe(false);
    expect(await readCheckoutMemoryOptIn(await checkout("plugins: [oops\n"))).toBe(false);
  });
});
