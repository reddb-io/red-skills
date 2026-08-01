/**
 * extension — the one file that knows it is running inside an editor.
 *
 * Everything under `src/model`, `src/watch` and `src/redskilled` is editor-free
 * and unit-tested against a fake daemon. This file is the wiring: resolve the
 * socket, build a read client, poll it, hand each frame to three trees and one
 * log panel, and turn the transitions into notifications.
 *
 * **It reads and never writes.** No command here starts, stops, recycles or
 * steers anything: ADR 0130 rule 9 makes reach asymmetric, and an editor panel
 * that could stop another project's Worker would be a control surface wearing a
 * monitor's name. The four commands it contributes refresh, show a log, copy an
 * id and reveal a workspace.
 */
import * as vscode from "vscode";
import { readSettings } from "./config.js";
import { buildEventsTree, buildPullRequestsTree, buildWorkersTree, type ViewNode } from "./model/nodes.js";
import { readHostSnapshot, type HostSnapshot } from "./model/snapshot.js";
import { createRedskilledReadClient } from "./redskilled/client.js";
import { resolveExtensionPaths } from "./redskilled/paths.js";
import { RedskilledTreeProvider } from "./views/tree.js";
import { WorkerLogPanel } from "./views/log-panel.js";
import { createWatcher } from "./watch/watcher.js";
import type { Signal } from "./watch/signals.js";

const SETTINGS_SECTION = "redskilled";

export function activate(context: vscode.ExtensionContext): void {
  let settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
  let paths = resolveExtensionPaths({ settingSocketPath: settings.socketPath });

  const workers = new RedskilledTreeProvider(buildWorkersTree);
  const events = new RedskilledTreeProvider(buildEventsTree);
  const pullRequests = new RedskilledTreeProvider(buildPullRequestsTree);
  const logPanel = new WorkerLogPanel();

  const watcher = createWatcher({
    read: async (): Promise<HostSnapshot> =>
      await readHostSnapshot({
        client: createRedskilledReadClient({ socketPath: paths.socketPath }),
        eventLanePath: paths.eventLanePath,
        source: paths.source,
      }),
    preferences: () => settings.notifications,
    renotifyMs: () => settings.renotifyMs,
    onSnapshot: (snapshot) => {
      workers.update(snapshot);
      events.update(snapshot);
      pullRequests.update(snapshot);
      const following = logPanel.following();
      if (following !== null) void logPanel.refresh(following);
    },
    onSignals: (signals) => {
      for (const signal of signals) announce(signal);
    },
  });

  // One timer, re-armed after each read rather than on a fixed interval: a host
  // that answers slowly must not accumulate a queue of reads behind it.
  let timer: NodeJS.Timeout | undefined;
  let disposed = false;
  const loop = (): void => {
    if (disposed) return;
    void watcher.tick().finally(() => {
      if (disposed) return;
      timer = setTimeout(loop, settings.pollIntervalMs);
    });
  };
  loop();

  context.subscriptions.push(
    vscode.window.createTreeView("redskilled.workers", { treeDataProvider: workers }),
    vscode.window.createTreeView("redskilled.events", { treeDataProvider: events }),
    vscode.window.createTreeView("redskilled.pullRequests", { treeDataProvider: pullRequests }),
    workers,
    events,
    pullRequests,
    logPanel,
    new vscode.Disposable(() => {
      disposed = true;
      if (timer) clearTimeout(timer);
    }),
    vscode.commands.registerCommand("redskilled.refresh", () => watcher.tick()),
    vscode.commands.registerCommand("redskilled.showWorkerLog", async (node?: ViewNode) => {
      if (!node?.workerId) return;
      await logPanel.show(node.workerId, node.logPath ?? null);
    }),
    vscode.commands.registerCommand("redskilled.copyWorkerId", async (node?: ViewNode) => {
      if (!node?.workerId) return;
      await vscode.env.clipboard.writeText(node.workerId);
    }),
    vscode.commands.registerCommand("redskilled.revealWorkspace", async (node?: ViewNode) => {
      if (!node?.workspacePath) return;
      await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(node.workspacePath));
    }),
    vscode.workspace.onDidChangeConfiguration((change) => {
      if (!change.affectsConfiguration(SETTINGS_SECTION)) return;
      settings = readSettings(vscode.workspace.getConfiguration(SETTINGS_SECTION));
      // The socket may have moved with the setting, so the path is re-derived
      // rather than kept: a pin an operator just changed is the one case where
      // holding the old answer is guaranteed wrong.
      paths = resolveExtensionPaths({ settingSocketPath: settings.socketPath });
      void watcher.tick();
    }),
  );
}

export function deactivate(): void {
  // Every lifetime is on `context.subscriptions`; there is nothing else to undo.
}

function announce(signal: Signal): void {
  const message = `${signal.title} — ${signal.body}`;
  if (signal.severity === "warning") {
    void vscode.window.showWarningMessage(message);
    return;
  }
  void vscode.window.showInformationMessage(message);
}
