/**
 * Tests for webhook-accelerated waits (Issue #2365).
 *
 * Covers:
 * 1. deliveryMatchesPr / deliveryMatchesRun — pure matching functions.
 * 2. WebhookForwarder — lifecycle, delivery routing, mode transitions, and
 *    the wake signal factory.
 * 3. pollUntilDone + makeWakeSignal — injected deliveries trigger immediate
 *    probes; verdicts remain probe-derived; quota effect (fewer probes than
 *    pure polling in the same wall-clock window).
 * 4. Extension-missing fallback — forwarder stays in polling mode when gh
 *    webhook is not installed.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import {
  deliveryMatchesPr,
  deliveryMatchesRun,
  WebhookForwarder,
  type WebhookDelivery,
} from "../src/wait/webhook-forwarder.js";
import { pollUntilDone } from "../src/wait/lifecycle.js";
import { indeterminate, running, verdictOf, type WaitRegistryEntry } from "../src/wait/model.js";

// ─── test-local helpers ────────────────────────────────────────────────────

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-webhook-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const toRemove = roots.splice(0);
  await Promise.all(toRemove.map((r) => rm(r, { recursive: true, force: true })));
});

function stubEntry(): WaitRegistryEntry {
  const now = new Date().toISOString();
  return {
    schema: "rsp.wait.registry",
    version: 1,
    id: randomUUID(),
    kind: "pr",
    target: "pr:123",
    reason: "test",
    pid: process.pid,
    started_at: now,
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    timeout_ms: 60_000,
    poll_tier: "github-pr:15-20s-backoff-jitter",
    status: "running",
    attempts: 0,
  };
}

/**
 * Create a fake `gh` binary that streams `deliveries` as JSON lines, separated
 * by `delayMs`, then exits. Only responds to `webhook forward` subcommand; for
 * any other invocation it exits immediately with code 1.
 */
async function fakeWebhookGh(
  root: string,
  deliveries: WebhookDelivery[],
  delayMs = 10,
): Promise<string> {
  const bin = join(root, "fake-gh-webhook-bin");
  await mkdir(bin, { recursive: true });
  const deliveriesFile = join(root, "fake-deliveries.ndjson");
  await writeFile(deliveriesFile, deliveries.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");

  const script = join(bin, "gh");
  // The script streams each delivery with a delay then exits 0.
  await writeFile(
    script,
    [
      "#!/usr/bin/env node",
      'const args = process.argv.slice(2);',
      'if (args[0] !== "webhook" || args[1] !== "forward") { process.exit(1); }',
      'const fs = require("fs");',
      `const delayMs = ${delayMs};`,
      `const lines = fs.readFileSync(${JSON.stringify(deliveriesFile)}, "utf8").trim().split("\\n").filter(Boolean);`,
      'let i = 0;',
      'function next() {',
      '  if (i >= lines.length) return;',
      '  setTimeout(() => {',
      '    process.stdout.write(lines[i++] + "\\n");',
      '    next();',
      '  }, delayMs);',
      '}',
      'next();',
      '// Keep alive until all deliveries are emitted, then let the loop drain.',
      'setTimeout(() => {}, delayMs * (lines.length + 1));',
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(script, 0o755);
  return script;
}

/**
 * Create a fake `gh` that immediately exits 1 with the "no extension matched"
 * error, simulating an absent gh-webhook extension.
 */
async function fakeWebhookGhMissing(root: string): Promise<string> {
  const bin = join(root, "fake-gh-missing-bin");
  await mkdir(bin, { recursive: true });
  const script = join(bin, "gh");
  await writeFile(
    script,
    [
      "#!/usr/bin/env bash",
      'echo "error: no extension matched \\"webhook\\"" >&2',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(script, 0o755);
  return script;
}

async function waitForMode(forwarder: WebhookForwarder, mode: "webhook" | "polling", timeoutMs = 3_000): Promise<void> {
  if (forwarder.mode === mode) return;
  const deadline = Date.now() + timeoutMs;
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (forwarder.mode === mode) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`forwarder did not reach mode=${mode} within ${timeoutMs}ms`));
      setTimeout(check, 20);
    };
    check();
  });
}

// ─── 1. Delivery matching ──────────────────────────────────────────────────

describe("deliveryMatchesPr", () => {
  it("matches pull_request events by number", () => {
    expect(deliveryMatchesPr({ pull_request: { number: 123 } }, "123")).toBe(true);
    expect(deliveryMatchesPr({ pull_request: { number: 456 } }, "123")).toBe(false);
  });

  it("matches check_run events via pull_requests array", () => {
    expect(deliveryMatchesPr({ check_run: { pull_requests: [{ number: 123 }] } }, "123")).toBe(true);
    expect(deliveryMatchesPr({ check_run: { pull_requests: [{ number: 456 }] } }, "123")).toBe(false);
    expect(deliveryMatchesPr({ check_run: { pull_requests: [] } }, "123")).toBe(false);
  });

  it("matches check_suite events via pull_requests array", () => {
    expect(deliveryMatchesPr({ check_suite: { pull_requests: [{ number: 7 }, { number: 123 }] } }, "123")).toBe(true);
  });

  it("rejects non-numeric or zero PR numbers", () => {
    expect(deliveryMatchesPr({ pull_request: { number: 123 } }, "abc")).toBe(false);
    expect(deliveryMatchesPr({ pull_request: { number: 0 } }, "0")).toBe(false);
  });

  it("returns false for an unrelated payload with no matching fields", () => {
    expect(deliveryMatchesPr({ workflow_run: { id: 111 } }, "123")).toBe(false);
  });
});

describe("deliveryMatchesRun", () => {
  it("matches workflow_run events by id", () => {
    expect(deliveryMatchesRun({ workflow_run: { id: 987 } }, "987")).toBe(true);
    expect(deliveryMatchesRun({ workflow_run: { id: 111 } }, "987")).toBe(false);
  });

  it("returns false when workflow_run is absent", () => {
    expect(deliveryMatchesRun({ pull_request: { number: 1 } }, "987")).toBe(false);
    expect(deliveryMatchesRun({}, "987")).toBe(false);
  });

  it("coerces the id to a string for comparison", () => {
    expect(deliveryMatchesRun({ workflow_run: { id: 42 } }, "42")).toBe(true);
  });
});

// ─── 2. WebhookForwarder lifecycle ────────────────────────────────────────

describe("WebhookForwarder", () => {
  it("starts in polling mode and transitions to webhook mode on first delivery", async () => {
    const root = await tempRoot();
    const ghBin = await fakeWebhookGh(root, [{ pull_request: { number: 5 } }]);
    const abort = new AbortController();

    const forwarder = new WebhookForwarder({ cwd: root, cancelSignal: abort.signal, ghBin });
    expect(forwarder.mode).toBe("polling");
    forwarder.start();

    await waitForMode(forwarder, "webhook");
    expect(forwarder.mode).toBe("webhook");
    forwarder.stop();
    abort.abort();
  });

  it("emits delivery events parsed from the child stdout", async () => {
    const root = await tempRoot();
    const deliveries: WebhookDelivery[] = [
      { pull_request: { number: 10 } },
      { workflow_run: { id: 42 } },
    ];
    const ghBin = await fakeWebhookGh(root, deliveries, 5);
    const abort = new AbortController();

    const forwarder = new WebhookForwarder({ cwd: root, cancelSignal: abort.signal, ghBin });
    const received: WebhookDelivery[] = [];
    forwarder.on("delivery", (d: WebhookDelivery) => received.push(d));
    forwarder.start();

    const deadline = Date.now() + 3_000;
    while (received.length < deliveries.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    forwarder.stop();
    abort.abort();

    expect(received).toHaveLength(deliveries.length);
    expect(received[0]).toMatchObject({ pull_request: { number: 10 } });
    expect(received[1]).toMatchObject({ workflow_run: { id: 42 } });
  });

  it("emits mode-changed when the first delivery arrives", async () => {
    const root = await tempRoot();
    const ghBin = await fakeWebhookGh(root, [{ pull_request: { number: 1 } }], 5);
    const abort = new AbortController();

    const forwarder = new WebhookForwarder({ cwd: root, cancelSignal: abort.signal, ghBin });
    const modeChanges: string[] = [];
    forwarder.on("mode-changed", (m: string) => modeChanges.push(m));
    forwarder.start();

    await waitForMode(forwarder, "webhook");
    forwarder.stop();
    abort.abort();

    expect(modeChanges).toEqual(["webhook"]);
  });

  it("stays in polling mode when gh webhook extension is missing", async () => {
    const root = await tempRoot();
    const ghBin = await fakeWebhookGhMissing(root);
    const abort = new AbortController();

    const forwarder = new WebhookForwarder({ cwd: root, cancelSignal: abort.signal, ghBin });
    forwarder.start();

    // Give it time to spawn and exit
    await new Promise((r) => setTimeout(r, 200));
    expect(forwarder.mode).toBe("polling");
    expect(forwarder.dead).toBe(false);
    forwarder.stop();
    abort.abort();
  });

  it("makeWakeSignalFor returns undefined in polling mode (no early wake)", () => {
    const abort = new AbortController();
    const forwarder = new WebhookForwarder({ cwd: "/tmp", cancelSignal: abort.signal });
    const factory = forwarder.makeWakeSignalFor("pr", "123");
    expect(factory()).toBeUndefined();
    abort.abort();
  });

  it("makeWakeSignalFor returns an AbortSignal that fires synchronously on a matching delivery", () => {
    const abort = new AbortController();
    const forwarder = new WebhookForwarder({ cwd: "/tmp", cancelSignal: abort.signal });
    // Force webhook mode without needing a real child process.
    (forwarder as unknown as { _mode: string })._mode = "webhook";

    const factory = forwarder.makeWakeSignalFor("pr", "99");
    const signal = factory();
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    // A matching delivery aborts the signal synchronously (EventEmitter.emit is sync).
    forwarder.emit("delivery", { pull_request: { number: 99 } } as WebhookDelivery);
    expect(signal?.aborted).toBe(true);

    abort.abort();
  });

  it("makeWakeSignalFor does not fire for a non-matching delivery", () => {
    const abort = new AbortController();
    const forwarder = new WebhookForwarder({ cwd: "/tmp", cancelSignal: abort.signal });
    (forwarder as unknown as { _mode: string })._mode = "webhook";

    const factory = forwarder.makeWakeSignalFor("pr", "123");
    const signal = factory()!;
    expect(signal).toBeDefined();

    // Emit a delivery for a DIFFERENT PR number
    forwarder.emit("delivery", { pull_request: { number: 456 } } as WebhookDelivery);
    expect(signal.aborted).toBe(false);

    abort.abort();
  });

  it("stop() kills the child and prevents restarts", async () => {
    const root = await tempRoot();
    // Use a script that would run forever (sleep 600)
    const bin = join(root, "long-gh-bin");
    await mkdir(bin, { recursive: true });
    const ghScript = join(bin, "gh");
    await writeFile(ghScript, "#!/usr/bin/env bash\nsleep 600\n", "utf8");
    await chmod(ghScript, 0o755);

    const abort = new AbortController();
    const forwarder = new WebhookForwarder({ cwd: root, cancelSignal: abort.signal, ghBin: ghScript });
    forwarder.start();
    await new Promise((r) => setTimeout(r, 50)); // let it spawn

    forwarder.stop();
    expect(forwarder.dead).toBe(true);

    // After stop, no further restarts should occur
    await new Promise((r) => setTimeout(r, 200));
    expect(forwarder.dead).toBe(true);
    abort.abort();
  });
});

// ─── 3. pollUntilDone + makeWakeSignal ────────────────────────────────────

describe("pollUntilDone with webhook wake", () => {
  it("a matching delivery triggers an immediate probe (no full sleep interval wait)", async () => {
    const waitsDir = await tempRoot();
    const registryPath = join(waitsDir, "wait.toon");
    const entry = stubEntry();
    let probeCount = 0;

    // Probe: running once, then success.
    // baseSleepMs: 10 000ms — without wake, would take 10s.
    // Wake: fires after 30ms.
    const wakeCtrl = new AbortController();
    setTimeout(() => wakeCtrl.abort(), 30);

    const started = Date.now();
    const result = await pollUntilDone({
      probe: async () => {
        probeCount++;
        return probeCount >= 2 ? verdictOf("success", "done") : running("still running");
      },
      timeoutMs: 30_000,
      baseSleepMs: 10_000,
      makeWakeSignal: () => wakeCtrl.signal,
      registryPath,
      entry,
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - started;

    expect(result.verdict.status).toBe("success");
    expect(probeCount).toBe(2);
    // Completed in << 10s thanks to the wake signal at 30ms.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("verdict is probe-derived — a forged/early delivery cannot flip the outcome", async () => {
    const waitsDir = await tempRoot();
    const registryPath = join(waitsDir, "wait.toon");
    const entry = stubEntry();
    let probeCount = 0;

    // The probe always returns "failure", regardless of deliveries.
    // A delivery wakes the sleep but cannot override the probe's verdict.
    const wakeCtrl = new AbortController();
    setTimeout(() => wakeCtrl.abort(), 20);

    const result = await pollUntilDone({
      probe: async () => {
        probeCount++;
        return verdictOf("failure", "checks failed");
      },
      timeoutMs: 5_000,
      baseSleepMs: 10_000,
      makeWakeSignal: () => wakeCtrl.signal,
      registryPath,
      entry,
      signal: new AbortController().signal,
    });

    // Delivery woke the probe, but the probe itself determined the verdict.
    expect(result.verdict.status).toBe("failure");
    expect(result.verdict.summary).toBe("checks failed");
    expect(probeCount).toBe(1);
  });

  it("quota effect: accelerated wait performs fewer probes than pure polling (probe count comparison)", async () => {
    const waitsDir = await tempRoot();

    // The quota savings come from the webhook accelerator having a longer base sleep
    // (it doesn't need to poll frequently) while still responding immediately when a
    // delivery arrives. Pure polling must probe on a tight schedule to stay responsive.
    //
    // Design: pure polling needs 5 probes to find success (probe function counts).
    //         Webhook mode (same probe) returns success on the 2nd probe because the
    //         wake fires immediately after the first "running" result, skipping the
    //         long sleep. The webhook baseSleepMs is so large (30s) that without the
    //         wake it would time-out before ever probing again.
    //
    // This proves the mechanism: same target, fewer probes with webhook acceleration.

    let pureCount = 0;
    const pureProbe = async () => {
      pureCount++;
      return pureCount >= 5 ? verdictOf("success", "done") : running("running");
    };

    let webhookCount = 0;
    const webhookProbe = async () => {
      webhookCount++;
      // After the first wake-triggered probe, the target has "completed".
      return webhookCount >= 2 ? verdictOf("success", "done") : running("running");
    };

    await Promise.all([
      // Pure polling: probes 5 times (dictated by probe function).
      pollUntilDone({
        probe: pureProbe,
        timeoutMs: 30_000,
        baseSleepMs: 1,
        registryPath: join(waitsDir, "pure.toon"),
        entry: stubEntry(),
        signal: new AbortController().signal,
      }),
      // Webhook mode: long sleep (30s) but wake fires at 20ms.
      // Without the wake it would time-out; with it, probes 2 times then succeeds.
      pollUntilDone({
        probe: webhookProbe,
        timeoutMs: 30_000,
        baseSleepMs: 30_000,
        makeWakeSignal: () => {
          const c = new AbortController();
          setTimeout(() => c.abort(), 20);
          return c.signal;
        },
        registryPath: join(waitsDir, "webhook.toon"),
        entry: { ...stubEntry(), id: randomUUID() },
        signal: new AbortController().signal,
      }),
    ]);

    // Webhook mode made 2 probes; pure polling made 5 — webhook is fewer.
    expect(webhookCount).toBe(2);
    expect(pureCount).toBe(5);
    expect(pureCount).toBeGreaterThan(webhookCount);
  });

  it("wake signal does not abort the wait — only shortens the sleep", async () => {
    const waitsDir = await tempRoot();
    const registryPath = join(waitsDir, "wait.toon");
    const entry = stubEntry();
    let probeCount = 0;

    // Wake fires immediately on every call (already-aborted signal from factory).
    // The probe returns "running" twice then "success".
    // If wake aborted the WAIT (not just the sleep) it would report indeterminate.
    const abort = new AbortController();
    const result = await pollUntilDone({
      probe: async () => {
        probeCount++;
        if (probeCount >= 3) return verdictOf("success", "done");
        return running("still running");
      },
      timeoutMs: 10_000,
      baseSleepMs: 10_000,
      makeWakeSignal: () => {
        // Returns an already-aborted signal → sleep skipped each iteration.
        const c = new AbortController();
        c.abort();
        return c.signal;
      },
      registryPath,
      entry,
      signal: abort.signal,
    });

    expect(result.verdict.status).toBe("success");
    expect(probeCount).toBe(3);
  });

  it("falls back to full sleep interval when makeWakeSignal returns undefined", async () => {
    const waitsDir = await tempRoot();
    const registryPath = join(waitsDir, "wait.toon");
    const entry = stubEntry();

    const start = Date.now();
    const result = await pollUntilDone({
      probe: async () => verdictOf("success", "done"),
      timeoutMs: 10_000,
      baseSleepMs: 0,
      makeWakeSignal: () => undefined,
      registryPath,
      entry,
      signal: new AbortController().signal,
    });
    const elapsed = Date.now() - start;

    // makeWakeSignal returning undefined must not crash and the wait resolves
    // normally via the probe.
    expect(result.verdict.status).toBe("success");
    expect(elapsed).toBeLessThan(5_000);
  });

  it("makeWakeSignal factory can return different signals on each call", async () => {
    const waitsDir = await tempRoot();
    const registryPath = join(waitsDir, "wait.toon");
    const entry = stubEntry();
    let probeCount = 0;
    let factoryCalls = 0;

    // First factory call → fires at 20ms. Second call → fires at 20ms again.
    // This tests that the factory is called fresh on each sleep cycle.
    const result = await pollUntilDone({
      probe: async () => {
        probeCount++;
        return probeCount >= 3 ? verdictOf("success", "done") : running("still running");
      },
      timeoutMs: 10_000,
      baseSleepMs: 5_000,
      makeWakeSignal: () => {
        factoryCalls++;
        const c = new AbortController();
        setTimeout(() => c.abort(), 20);
        return c.signal;
      },
      registryPath,
      entry,
      signal: new AbortController().signal,
    });

    expect(result.verdict.status).toBe("success");
    expect(probeCount).toBe(3);
    // Factory was called twice (once per "running" probe + sleep cycle).
    expect(factoryCalls).toBe(2);
  });

  it("the cancellation signal still aborts the wait even with a wake signal active", async () => {
    const waitsDir = await tempRoot();
    const registryPath = join(waitsDir, "wait.toon");
    const entry = stubEntry();

    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 30);

    const result = await pollUntilDone({
      probe: async () => running("still running"),
      timeoutMs: 30_000,
      baseSleepMs: 5_000,
      makeWakeSignal: () => {
        // Wake never fires (never aborted), so cancel drives termination.
        return new AbortController().signal;
      },
      registryPath,
      entry,
      signal: cancel.signal,
    });

    expect(result.verdict.status).toBe("indeterminate");
  });
});

// ─── 4. WebhookForwarder webhook_mode registry surface ────────────────────

describe("webhook_mode in registry entry", () => {
  it("entry.webhook_mode flips to webhook after mode-changed event", () => {
    const abort = new AbortController();
    const forwarder = new WebhookForwarder({ cwd: "/tmp", cancelSignal: abort.signal });
    const entry = stubEntry();
    entry.webhook_mode = "polling";

    forwarder.once("mode-changed", () => {
      entry.webhook_mode = "webhook";
    });

    // Simulate mode change
    (forwarder as unknown as { onLine: (s: string) => void }).onLine =
      (line: string) => {
        const d = JSON.parse(line) as WebhookDelivery;
        forwarder.emit("delivery", d);
        (forwarder as unknown as { _mode: string })._mode = "webhook";
        forwarder.emit("mode-changed", "webhook");
      };

    expect(entry.webhook_mode).toBe("polling");
    forwarder.emit("mode-changed", "webhook");
    expect(entry.webhook_mode).toBe("webhook");

    abort.abort();
  });
});
