import { describe, expect, it, vi } from "vitest";
import {
  attempt,
  BootHaltError,
  facts,
  makeDeps,
  options,
  runBoot,
  type BootDeps,
} from "./boot.helpers.js";

describe("runBoot precheck short-circuit", () => {
  it("aborts before bootstrap on a precheck failure", async () => {
    const { deps, calls } = makeDeps();
    const result = await runBoot(deps, options({ precheck: facts({ ghInstalled: false }) }));
    expect(result.precheck).toEqual({ ok: false, failed: "gh-missing" });
    expect(result.bootstrap).toBeUndefined();
    expect(result.orphanCleanup).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("refuses on a red operational probe before bootstrap, naming the probe and fix", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      runBoot(
        deps,
        options({
          precheck: facts({
            remoteUrls: [{ name: "origin", url: "https://github.com/reddb-io/red-skills.git" }],
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "operational-probe",
      probe: {
        name: "SSH-only git remotes",
        canonicalFix: expect.stringContaining("Use SSH git remotes"),
      },
    });
    await expect(
      runBoot(
        deps,
        options({
          precheck: facts({
            remoteUrls: [{ name: "origin", url: "https://github.com/reddb-io/red-skills.git" }],
          }),
        }),
      ),
    ).rejects.toThrow(/SSH-only git remotes.*Use SSH git remotes/);
    expect(calls).toEqual([]);
  });

  it("refuses on an unlistable queue, naming the queue visibility probe", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      runBoot(
        deps,
        options({
          precheck: facts({
            remoteUrls: [],
            queueVisibility: {
              listEngineCandidates: async () => {
                throw Object.assign(new Error("Resource protected by organization SAML enforcement"), {
                  surface: "graphql",
                });
              },
              listRestQueue: async () => [3],
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "operational-probe",
      probe: {
        name: "AFK queue visibility",
        canonicalFix: expect.stringContaining("gh auth refresh"),
      },
    });
    expect(calls).toEqual([]);
  });

  it("keeps a worker session alive and logs info when queue skew clears on re-sample", async () => {
    const log = vi.fn();
    const { deps, fsCalls } = makeDeps({ log });
    const listEngineCandidates = vi.fn()
      .mockResolvedValueOnce([2448])
      .mockResolvedValueOnce([2448, 2449]);
    const listRestQueue = vi.fn().mockResolvedValue([2448, 2449]);

    const result = await runBoot(
      deps,
      options({
        skipSweeps: true,
        precheck: facts({
          queueVisibility: {
            listEngineCandidates,
            listRestQueue,
            resampleDelayMs: 0,
          },
        }),
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(fsCalls.workerPid).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "info: transient queue mismatch cleared on re-sample; first differing issues: #2449",
    );
  });

  it("auto-concedes a seeded same-machine dead-pid ghost claim and continues boot", async () => {
    const concedeClaim = vi.fn(async (_issue: number, _body: string) => {});
    const log = vi.fn();
    const { deps, fsCalls } = makeDeps({ log });
    deps.concedeClaim = concedeClaim;

    const result = await runBoot(
      deps,
      options({
        skipSweeps: true,
        operationalProbes: {
          remoteUrls: [],
          claimHygiene: {
            ownWorkerPrefix: "testhost:",
            listOpenQueueIssues: async () => [
              {
                number: 2473,
                comments: [
                  {
                    id: 10,
                    body: "<!-- afk:claim v1 worker=testhost:wGHOST kind=claim runner=codex -->",
                  },
                ],
              },
            ],
            workerPidState: () => "dead",
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(fsCalls.workerPid).toHaveLength(1);
    expect(concedeClaim).toHaveBeenCalledOnce();
    expect(concedeClaim.mock.calls[0]?.[0]).toBe(2473);
    expect(concedeClaim.mock.calls[0]?.[1]).toContain(
      "worker=testhost:wGHOST kind=concede runner=codex",
    );
    expect(log).toHaveBeenCalledWith(
      "boot operational probe auto-fix applied: afk.claim-hygiene; posted 1 concede marker",
    );
  });

  it("auto-applies guarded base-freshness before bootstrap and logs the before/after SHAs", async () => {
    const fastForwardLocalBase = vi.fn(async () => ({
      action: "fast-forward" as const,
      guard: "passed" as const,
      target: "main",
      remote: "origin",
      currentBranch: "main",
      evidence: "fast-forwarded main to origin/main",
    }));
    const log = vi.fn();
    const { deps, calls } = makeDeps({ fastForwardLocalBase, log });

    const result = await runBoot(
      deps,
      options({
        operationalProbes: {
          remoteUrls: [],
          baseFreshness: {
            trunk: "main",
            remote: "origin",
            localSha: "1111111111111111111111111111111111111111",
            remoteSha: "2222222222222222222222222222222222222222",
            ahead: 0,
            behind: 1,
            remoteReachable: true,
            guard: {
              guard: "passed",
              target: "main",
              remote: "origin",
              currentBranch: "main",
              evidence: "guard passed: on-trunk clean-tree ancestor (main -> origin/main)",
            },
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(fastForwardLocalBase).toHaveBeenCalledWith({ remote: "origin", target: "main" });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "boot operational probe auto-fix applied: afk.base-freshness before=111111111111 after=222222222222",
      ),
    );
    expect(calls.slice(0, 3)).toEqual([
      "fs.ensureDir:/p/.red/tmp",
      "fs.ensureDir:/p/.red/state",
      "fs.gitignore:.red/tmp/",
    ]);
  });

  it("boots after reconciling patch-equivalent divergent commits and logs the SHA pair (#3248)", async () => {
    const localSha = "1111111111111111111111111111111111111111";
    const remoteSha = "2222222222222222222222222222222222222222";
    const pair = `${localSha} -> ${remoteSha}`;
    const fastForwardLocalBase = vi.fn(async () => ({
      action: "fast-forward" as const,
      guard: "passed" as const,
      target: "main",
      remote: "origin",
      currentBranch: "main",
      supersededCommits: [{ localSha, remoteSha }],
      evidence: `reconciled superseded commits and moved main to origin/main: ${pair}`,
    }));
    const log = vi.fn();
    const { deps } = makeDeps({ fastForwardLocalBase, log });

    const result = await runBoot(
      deps,
      options({
        operationalProbes: {
          remoteUrls: [],
          baseFreshness: {
            trunk: "main",
            remote: "origin",
            localSha,
            remoteSha,
            ahead: 1,
            behind: 2,
            remoteReachable: true,
            guard: {
              guard: "passed",
              target: "main",
              remote: "origin",
              currentBranch: "main",
              supersededCommits: [{ localSha, remoteSha }],
              evidence: `guard passed: on-trunk clean-tree superseded-commits (${pair})`,
            },
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(fastForwardLocalBase).toHaveBeenCalledWith({ remote: "origin", target: "main" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(pair));
  });

  it.each([
    [
      "off-trunk",
      {
        guard: "refused" as const,
        target: "main",
        remote: "origin",
        currentBranch: "feature/work",
        failed: "not-on-trunk" as const,
        failedCondition: "on-trunk" as const,
        evidence: "condition failed: on-trunk (current=feature/work expected=main)",
      },
    ],
    [
      "dirty tree",
      {
        guard: "refused" as const,
        target: "main",
        remote: "origin",
        currentBranch: "main",
        failed: "dirty-tree" as const,
        failedCondition: "clean-tree" as const,
        evidence: "condition failed: clean-tree (1 dirty path(s))",
      },
    ],
    [
      "diverged",
      {
        guard: "refused" as const,
        target: "main",
        remote: "origin",
        currentBranch: "main",
        failed: "not-ancestor" as const,
        failedCondition: "ancestor" as const,
        evidence: "condition failed: ancestor (main is not an ancestor of origin/main)",
      },
    ],
  ])("keeps halting on base-freshness when the guard refuses: %s", async (_name, guard) => {
    const fastForwardLocalBase = vi.fn();
    const { deps, calls } = makeDeps({ fastForwardLocalBase });

    await expect(
      runBoot(
        deps,
        options({
          operationalProbes: {
            remoteUrls: [],
            baseFreshness: {
              trunk: "main",
              remote: "origin",
              localSha: "1111111111111111111111111111111111111111",
              remoteSha: "2222222222222222222222222222222222222222",
              ahead: 0,
              behind: 1,
              remoteReachable: true,
              guard,
            },
          },
        }),
      ),
    ).rejects.toThrow(/Operational probe red: AFK local trunk freshness/);

    expect(fastForwardLocalBase).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  /**
   * #3155 — a Worker dying on trunk freshness reported `claim-lost` on the
   * targeted-dispatch entrance and `session-error` on the queue-drain one, and
   * neither message mentioned the trunk, the merge or the file. Both entrances
   * format the halt from this one finding, so the cause must be IN it: the
   * trunk, how far behind it is, and the path blocking the fast-forward.
   */
  describe("a trunk-freshness halt names the trunk and the blocking path (#3155)", () => {
    const behindBase = {
      trunk: "main",
      remote: "origin",
      localSha: "1111111111111111111111111111111111111111",
      remoteSha: "2222222222222222222222222222222222222222",
      ahead: 0,
      behind: 18,
      remoteReachable: true,
    };
    const collisionEvidence =
      "condition failed: dirt-collision (1 locally-modified /red-setup file(s) also changed by origin/main: .red/config.yaml) — commit or stash them, then the fast-forward can land";

    async function haltMessage(over: Parameters<typeof makeDeps>[0], guard: Record<string, unknown>): Promise<string> {
      const { deps } = makeDeps(over);
      try {
        await runBoot(
          deps,
          options({
            operationalProbes: {
              remoteUrls: [],
              baseFreshness: { ...behindBase, guard: guard as never },
            },
          }),
        );
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("boot did not halt");
    }

    it("names both when the guard refuses the collision up front", async () => {
      const message = await haltMessage({ fastForwardLocalBase: vi.fn() }, {
        guard: "refused",
        target: "main",
        remote: "origin",
        currentBranch: "main",
        failed: "dirt-collision",
        failedCondition: "dirt-collision",
        evidence: collisionEvidence,
      });
      expect(message).toContain("local main is 18 commit(s) behind origin/main");
      expect(message).toContain(".red/config.yaml");
    });

    it("names both when the guard passed and the fast-forward then declined", async () => {
      const message = await haltMessage(
        {
          fastForwardLocalBase: vi.fn(async () => ({
            action: "noop" as const,
            guard: "refused" as const,
            target: "main",
            remote: "origin",
            evidence: collisionEvidence,
          })),
        },
        {
          guard: "passed",
          target: "main",
          remote: "origin",
          currentBranch: "main",
          evidence: "guard passed: on-trunk clean-tree ancestor (main -> origin/main)",
        },
      );
      expect(message).toContain("local main is 18 commit(s) behind origin/main");
      expect(message).toContain(".red/config.yaml");
      // The stale passing verdict must not survive a repair that errored out.
      expect(message).not.toContain("guard=passed");
    });
  });

  it("refuses boot on discarded config fallback, naming the config coherence probe", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      runBoot(
        deps,
        options({
          precheck: facts({
            remoteUrls: [],
            configCoherence: {
              path: "/repo/.red/config.yaml",
              displayPath: ".red/config.yaml",
              fileLoaded: true,
              discarded: true,
              parseFailure: {
                message: "malformed YAML at line 4: expected a mapping key",
                line: 4,
                construct: "expected a mapping key",
              },
              rootAccessorCollisions: [],
              resolved: { trunk: "main", gate: "", lock: "" },
            },
          }),
        }),
      ),
    ).rejects.toMatchObject({
      phase: "operational-probe",
      probe: {
        id: "config.coherence",
        name: "Config coherence",
        evidence: expect.stringContaining("line 4: expected a mapping key"),
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("runBoot Docs Sweep", () => {
  it("lands stranded docs before the unblock sweep", async () => {
    const blockerState: BootDeps["lookups"]["blockerState"] = async () => "CLOSED";
    const { deps, calls } = makeDeps({
      blockerState,
      docsSweepLander: async (plan) => {
        calls.push(`docs.land:${plan.files.map((f) => f.path).join(",")}`);
        return { ok: true };
      },
    });

    await runBoot(
      deps,
      options({
        docsSweep: {
          base: "main",
          files: [
            {
              path: ".red/CONTEXT-MAP.md",
              state: "modified",
              group: "glossary",
              ignored: false,
              trackedPrecedent: true,
            },
          ],
        },
        unblockCandidates: [
          { number: 100, labels: ["blocked:dependency"], body: "## Blocked by\n\n- [ ] #10\n" },
        ],
      }),
    );

    expect(calls.indexOf("docs.land:.red/CONTEXT-MAP.md")).toBeLessThan(calls.indexOf("gh.editLabels:100"));
  });

  it("halts before worker-consumable sweeps when stranded docs cannot land", async () => {
    const { deps, calls } = makeDeps();
    await expect(
      runBoot(
        deps,
        options({
          docsSweep: {
            base: "main",
            files: [
              {
                path: ".red/adr/0099-docs-sweep.md",
                state: "untracked",
                group: "adr",
                ignored: true,
                trackedPrecedent: false,
              },
            ],
          },
          unblockCandidates: [
            { number: 100, labels: ["blocked:dependency"], body: "## Blocked by\n\n- [ ] #10\n" },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(BootHaltError);
    expect(calls).not.toContain("gh.editLabels:100");
  });
});

describe("runBoot bootstrap", () => {
  it("ensures dirs, gitignore lines, and writes worker.pid", async () => {
    const { deps, fsCalls } = makeDeps();
    await runBoot(deps, options());
    expect(fsCalls.ensureDir).toEqual([
      "/p/.red/tmp",
      "/p/.red/state",
      "/p/.red/tmp/workers/wAAA",
    ]);
    expect(fsCalls.gitignore).toEqual([".red/tmp/", ".red/state/"]);
    expect(fsCalls.workerPid).toEqual([
      { path: "/p/.red/tmp/workers/wAAA/worker.pid", pid: 4242 },
    ]);
  });
});

describe("runBoot skipSweeps — supervisor-owned boot (#623)", () => {
  it("runs precheck + bootstrap then returns before every sweep", async () => {
    const { deps, calls, fsCalls } = makeDeps();
    // Provide sweep INPUTS that would normally trigger work, to prove they are
    // ignored once skipSweeps is set: an orphan dir, an attempt-cap group, a
    // reapable branch, and an unblock candidate.
    const result = await runBoot(
      deps,
      options({
        skipSweeps: true,
        orphans: [{ path: "/d/orphan", issue: 7, ageS: 999_999 }],
        attemptCap: { byIssue: new Map([[7, [attempt(7, 1, 999_999)]]]) },
        branches: { remoteLiveRefs: [], localLiveRefs: [] },
        unblockCandidates: [{ number: 9, body: "", labels: ["blocked:dependency", "req:1"] }],
      }),
    );

    // Bootstrap still ran (dirs + gitignore + worker.pid).
    expect(fsCalls.ensureDir).toEqual([
      "/p/.red/tmp",
      "/p/.red/state",
      "/p/.red/tmp/workers/wAAA",
    ]);
    expect(fsCalls.workerPid).toHaveLength(1);
    // …but NOTHING else: no removeDir, no gh, no git — every sweep was skipped.
    expect(fsCalls.removeDir).toEqual([]);
    expect(calls.filter((c) => c.startsWith("gh.") || c.startsWith("git."))).toEqual([]);

    // The result carries only precheck + bootstrap; every sweep field is absent.
    expect(result.precheck.ok).toBe(true);
    expect(result.bootstrap).toEqual({ ok: true });
    expect(result.orphanCleanup).toBeUndefined();
    expect(result.attemptCap).toBeUndefined();
    expect(result.branchCleanup).toBeUndefined();
    expect(result.tmpJanitor).toBeUndefined();
    expect(result.unblockSweep).toBeUndefined();
    expect(result.reconcileSweep).toBeUndefined();
    expect(result.straggler).toBeUndefined();
  });

  it("still aborts on a precheck failure before bootstrap", async () => {
    const { deps, calls } = makeDeps();
    const result = await runBoot(
      deps,
      options({ skipSweeps: true, precheck: facts({ ghInstalled: false }) }),
    );
    expect(result.precheck).toEqual({ ok: false, failed: "gh-missing" });
    expect(result.bootstrap).toBeUndefined();
    expect(calls).toEqual([]);
  });

  // Regression test for #2054: base-freshness probe kills worker sessions when local
  // main is behind origin after a release. Workers branch from origin/main, so a
  // behind local main does not affect their work — downgrade to non-fatal when guard passes.
  it("does NOT halt on base-freshness guard=passed — worker branches from origin/main anyway", async () => {
    // No fastForwardLocalBase dep (matches buildMinimalBootDeps for worker sessions).
    const { deps, fsCalls } = makeDeps();

    const result = await runBoot(
      deps,
      options({
        skipSweeps: true,
        operationalProbes: {
          remoteUrls: [],
          baseFreshness: {
            trunk: "main",
            remote: "origin",
            localSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
            remoteSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ahead: 0,
            behind: 1,
            remoteReachable: true,
            guard: {
              guard: "passed",
              target: "main",
              remote: "origin",
              currentBranch: "main",
              evidence: "guard passed: on-trunk clean-tree ancestor (main -> origin/main)",
            },
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    // The finding is still recorded in the probe report (visible in logs) but non-fatal.
    expect(result.operationalProbes?.findings).toHaveLength(1);
    expect(result.operationalProbes?.findings[0]?.id).toBe("afk.base-freshness");
    // Bootstrap ran normally.
    expect(fsCalls.ensureDir).toContain("/p/.red/tmp");
  });

  it("does NOT halt when local main is behind and primary WIP refuses auto-FF", async () => {
    const { deps, fsCalls } = makeDeps();

    const result = await runBoot(
      deps,
      options({
        skipSweeps: true,
        operationalProbes: {
          remoteUrls: [],
          baseFreshness: {
            trunk: "main",
            remote: "origin",
            localSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
            remoteSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            ahead: 0,
            behind: 1,
            remoteReachable: true,
            guard: {
              guard: "refused",
              target: "main",
              remote: "origin",
              currentBranch: "main",
              failed: "dirty-tree",
              failedCondition: "clean-tree",
              evidence: "condition failed: clean-tree (1 dirty path(s))",
            },
          },
        },
      }),
    );

    expect(result.bootstrap).toEqual({ ok: true });
    expect(result.operationalProbes?.findings).toHaveLength(1);
    expect(result.operationalProbes?.findings[0]?.evidence).toContain("guard=refused");
    expect(fsCalls.ensureDir).toContain("/p/.red/tmp");
  });

  it.each([
    [
      "off-trunk",
      {
        guard: "refused" as const,
        target: "main",
        remote: "origin",
        currentBranch: "feature/work",
        failed: "not-on-trunk" as const,
        failedCondition: "on-trunk" as const,
        evidence: "condition failed: on-trunk (current=feature/work expected=main)",
      },
    ],
    [
      "diverged",
      {
        guard: "refused" as const,
        target: "main",
        remote: "origin",
        currentBranch: "main",
        failed: "not-ancestor" as const,
        failedCondition: "ancestor" as const,
        evidence: "condition failed: ancestor (main is not an ancestor of origin/main)",
      },
    ],
  ])("still halts on base-freshness guard=refused in worker session: %s", async (_name, guard) => {
    const { deps } = makeDeps();

    await expect(
      runBoot(
        deps,
        options({
          skipSweeps: true,
          operationalProbes: {
            remoteUrls: [],
            baseFreshness: {
              trunk: "main",
              remote: "origin",
              localSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
              remoteSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              ahead: 0,
              behind: 1,
              remoteReachable: true,
              guard,
            },
          },
        }),
      ),
    ).rejects.toThrow(/Operational probe red: AFK local trunk freshness/);
  });

  it("still halts on a second red probe even when base-freshness guard=passed is exempt", async () => {
    const { deps } = makeDeps();

    await expect(
      runBoot(
        deps,
        options({
          skipSweeps: true,
          operationalProbes: {
            remoteUrls: [],
            baseFreshness: {
              trunk: "main",
              remote: "origin",
              localSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
              remoteSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              ahead: 0,
              behind: 1,
              remoteReachable: true,
              guard: {
                guard: "passed",
                target: "main",
                remote: "origin",
                currentBranch: "main",
                evidence: "guard passed: on-trunk clean-tree ancestor (main -> origin/main)",
              },
            },
            configCoherence: {
              path: "/repo/.red/config.yaml",
              displayPath: ".red/config.yaml",
              fileLoaded: true,
              discarded: true,
              parseFailure: { message: "malformed YAML at line 3", line: 3 },
              rootAccessorCollisions: [],
              resolved: { trunk: "main", gate: "", lock: "" },
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      phase: "operational-probe",
      probe: { id: "config.coherence" },
    });
  });
});
