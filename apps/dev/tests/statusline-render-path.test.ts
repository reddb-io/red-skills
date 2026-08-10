import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const { directCollector, runStatusline } = vi.hoisted(() => ({
  directCollector: vi.fn(() => {
    throw new Error("the render path called a project collector");
  }),
  runStatusline: vi.fn(async (
    _args: readonly string[],
    io: { readonly cwd?: string; readonly write?: (line: string) => void },
  ) => {
    io.write?.(
      "acme/widgets 1w 128M v3.12.10\n" +
      "w123  ███▶░░  run=codex gpt-5.6 xhigh  iss=3546  implementing·tests  00:02:03  loc=+12 -3  tks=45k  tls=9 rsn=2 txt=1\n",
    );
    return 0;
  }),
}));

vi.mock("@reddb-io/redskilled/statusline-command", () => ({ runStatusline }));

vi.mock("../src/runtime/wire.js", () => ({
  collectStatuslineAfk: directCollector,
  collectStatuslineDocs: directCollector,
  collectStatuslineFleet: directCollector,
  collectStatuslineRepo: directCollector,
  collectStatuslineValidationGate: directCollector,
  collectStatuslineWorkers: directCollector,
  inferGitHubRepoSlug: directCollector,
  refreshStatuslineCountCache: directCollector,
  refreshStatuslineRepoCache: directCollector,
  resolveStatuslineCacheTtl: directCollector,
}));

import { statuslineCommand } from "../src/commands/statusline.js";

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeStdin(text: string): NodeJS.ReadableStream & { isTTY?: boolean } {
  const stream = Readable.from([text]) as Readable & { isTTY?: boolean };
  stream.isTTY = false;
  return stream;
}

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk: string | Uint8Array): boolean {
        output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    text: () => output,
  };
}

describe("dev statusline render path", () => {
  it("renders the daemon document without invoking a project collector or API client", async () => {
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);
    const out = sink();

    const started = performance.now();
    const code = await statuslineCommand(
      [root, "global", "--verbose", "--no-workers"],
      root,
      out.stream,
      fakeStdin(JSON.stringify({ workspace: { project_dir: root } })),
    );
    const adapterMs = performance.now() - started;

    expect(code).toBe(0);
    expect(runStatusline).toHaveBeenCalledOnce();
    expect(runStatusline).toHaveBeenCalledWith(
      ["global", "--verbose"],
      expect.objectContaining({ cwd: root }),
    );
    expect(directCollector).not.toHaveBeenCalled();
    expect(out.text()).toContain("run=codex gpt-5.6 xhigh");
    expect(out.text()).toContain("iss=3546");
    expect(out.text()).toContain("loc=+12 -3  tks=45k  tls=9 rsn=2 txt=1");
    // Repro baseline from #3546: daemon read 0.53s; old dev render 7.03–8.08s.
    // The adapter adds less than 100ms in-process, keeping total render time in
    // the daemon read's order of magnitude while leaving socket time measurable
    // in the daemon client rather than hiding it behind tracker subprocesses.
    expect(adapterMs).toBeLessThan(100);
  });

  it("prints the daemon client's stated absence promptly without a tracker fallback", async () => {
    runStatusline.mockImplementationOnce(async (_args, io) => {
      io.write?.("redskilled unreachable — Worker state unknown\n");
      return 0;
    });
    const root = await mkdtemp(join(tmpdir(), "statusline-render-path-"));
    roots.push(root);
    const out = sink();

    const started = performance.now();
    const code = await statuslineCommand([root], root, out.stream, fakeStdin(""));

    expect(code).toBe(0);
    expect(out.text()).toBe("redskilled unreachable — Worker state unknown\n");
    expect(directCollector).not.toHaveBeenCalled();
    expect(performance.now() - started).toBeLessThan(100);
  });
});
