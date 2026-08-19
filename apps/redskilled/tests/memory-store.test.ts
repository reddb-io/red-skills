import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { workerModeEnv, RED_MODE_ENV } from "@reddb-io/shared/working-mode.js";

import {
  createProjectMemoryStore,
  type MemoryEnginePort,
  type MemoryToolDescriptor,
} from "../src/memory-store.js";
import { checkoutMemoryRoot, projectMemoryRoot } from "../src/memory-root.js";
import type { AcpProjectIdentity } from "../src/project-workspace.js";

const TOOLS: MemoryToolDescriptor[] = [
  { name: "memory_stats", description: "counts", inputSchema: { type: "object" } },
];

interface Recorder {
  readonly engine: MemoryEnginePort;
  readonly opened: string[];
  readonly served: Array<{ root: string; tool: string }>;
}

function recordingEngine(): Recorder {
  const opened: string[] = [];
  const served: Array<{ root: string; tool: string }> = [];
  return {
    opened,
    served,
    engine: {
      async open(root) {
        opened.push(root);
        return {
          tools: async () => TOOLS,
          call: async (tool) => {
            served.push({ root, tool });
            return { ok: true };
          },
          close: async () => {},
        };
      },
    },
  };
}

const OPTED_IN = "plugins:\n  memory:\n    enabled: true\n    store: checkout\n";

async function optedInCheckout(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-memory-store-"));
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), OPTED_IN, "utf8");
  return root;
}

function project(checkoutRoot: string): AcpProjectIdentity {
  return { projectId: "github:4027", projectLabel: "reddb-io/red-skills", checkoutRoot };
}

const HOME = "/home/operator";

describe("the daemon's per-Project memory handles (ADR 0152)", () => {
  it("opens the Project's own store when the repository did not opt in", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "redskilled-memory-store-"));
    const recorder = recordingEngine();
    const store = createProjectMemoryStore({ engine: recorder.engine, env: { HOME } });

    const answer = await store.call(project(checkout), { tool: "memory_stats", arguments: {} });

    expect(answer.scope).toBe("project");
    expect(answer.root).toBe(projectMemoryRoot(HOME, "github:4027"));
    expect(recorder.opened).toEqual([projectMemoryRoot(HOME, "github:4027")]);
    await store.close();
  });

  it("opens the checkout's store for a human in a repository that opted in", async () => {
    const checkout = await optedInCheckout();
    const recorder = recordingEngine();
    const store = createProjectMemoryStore({ engine: recorder.engine, env: { HOME } });

    const answer = await store.call(project(checkout), { tool: "memory_stats", arguments: {} });

    expect(answer.scope).toBe("checkout");
    expect(recorder.opened).toEqual([checkoutMemoryRoot(checkout)]);
    await store.close();
  });

  /**
   * Acceptance criterion of #4027, stated against the environment a Worker is
   * actually born with rather than a hand-typed string: whatever
   * `workerModeEnv` exports is the mode that must keep a Worker off the human's
   * disk, so a fifth mode added there is caught here.
   */
  it("never reaches the checkout for a Worker, whatever mode its spawn env declares", async () => {
    for (const kind of ["afk", "go", "scout"] as const) {
      const mode = workerModeEnv(kind)[RED_MODE_ENV] as "spec-driven" | "ad-hoc";
      const checkout = await optedInCheckout();
      const recorder = recordingEngine();
      const store = createProjectMemoryStore({ engine: recorder.engine, env: { HOME } });

      const answer = await store.call(project(checkout), {
        tool: "memory_stats",
        arguments: {},
        mode,
      });

      expect(answer.scope, kind).toBe("project");
      expect(recorder.opened, kind).toEqual([projectMemoryRoot(HOME, "github:4027")]);
      expect(recorder.served, kind).toEqual([
        { root: projectMemoryRoot(HOME, "github:4027"), tool: "memory_stats" },
      ]);
      // The disk half: the opted-in checkout keeps exactly the `.red` it had.
      // A memory store opened there would have created `.red/memory` beside it.
      expect(await readdir(join(checkout, ".red")), kind).toEqual(["config.yaml"]);
      await store.close();
    }
  });

  it("shares one open between two callers that resolve to the same root", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "redskilled-memory-store-"));
    const recorder = recordingEngine();
    const store = createProjectMemoryStore({ engine: recorder.engine, env: { HOME } });

    await Promise.all([
      store.call(project(checkout), { tool: "memory_stats", arguments: {} }),
      store.call(project(checkout), { tool: "memory_stats", arguments: {}, mode: "spec-driven" }),
    ]);

    expect(recorder.opened, "one root, two opens — the shape the daemon took the store over to remove")
      .toEqual([projectMemoryRoot(HOME, "github:4027")]);
    await store.close();
  });

  it("answers `memory_tools` itself, naming the store that would have answered", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "redskilled-memory-store-"));
    const recorder = recordingEngine();
    const store = createProjectMemoryStore({ engine: recorder.engine, env: { HOME } });

    const answer = await store.call(project(checkout), { tool: "memory_tools", arguments: {} });

    expect(answer.result).toMatchObject({
      tools: TOOLS,
      root: projectMemoryRoot(HOME, "github:4027"),
      scope: "project",
    });
    expect(recorder.served, "the surface probe is the daemon's own answer").toEqual([]);
    await store.close();
  });

  it("refuses a tool the Project's store does not publish", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "redskilled-memory-store-"));
    const store = createProjectMemoryStore({ engine: recordingEngine().engine, env: { HOME } });

    await expect(store.call(project(checkout), { tool: "memory_invented", arguments: {} }))
      .rejects.toThrow(/publishes no memory tool named "memory_invented"/);
    await store.close();
  });

  it("drops a failed open so a transient failure does not poison the host", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "redskilled-memory-store-"));
    let attempts = 0;
    const store = createProjectMemoryStore({
      env: { HOME },
      engine: {
        async open() {
          attempts += 1;
          if (attempts === 1) throw new Error("the store was busy");
          return { tools: async () => TOOLS, call: async () => ({ ok: true }), close: async () => {} };
        },
      },
    });

    await expect(store.call(project(checkout), { tool: "memory_stats", arguments: {} }))
      .rejects.toThrow("the store was busy");
    await expect(store.call(project(checkout), { tool: "memory_stats", arguments: {} }))
      .resolves.toMatchObject({ scope: "project" });
    expect(attempts).toBe(2);
    await store.close();
  });
});
