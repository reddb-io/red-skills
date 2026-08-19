/**
 * dashboard-panel — the Worker rows, in a panel that refreshes with the daemon.
 *
 * ONE panel, created on demand and disposed with the window that closes it. It
 * re-renders on every frame the watcher delivers, so a state change in the daemon
 * reaches the reader without a command, a click, or a second read.
 *
 * What it shows is decided entirely by `model/dashboard-view.ts`, which is pure
 * and reads a document the DAEMON rendered. This file owns the webview lifetime
 * and nothing else — there is no cell here to get wrong.
 */
import * as vscode from "vscode";
import { renderDashboardHtml } from "../model/dashboard-view.js";
import type { HostSnapshot } from "../model/snapshot.js";

const VIEW_TYPE = "redskilled.dashboard";

export class RedskilledDashboardPanel {
  private panel: vscode.WebviewPanel | null = null;
  private snapshot: HostSnapshot | null = null;

  /** Reveal the panel, creating it on the first call. */
  show(): void {
    if (this.panel === null) {
      this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, "redskilled — dashboard", vscode.ViewColumn.Active, {
        // Nothing here runs a script or reads a file: the body is text the daemon
        // rendered, escaped once. A webview that could do more would be a control
        // surface wearing a monitor's name (ADR 0130 rule 9).
        enableScripts: false,
        retainContextWhenHidden: true,
      });
      this.panel.onDidDispose(() => {
        this.panel = null;
      });
      this.paint();
      return;
    }
    this.panel.reveal(undefined, true);
  }

  /** True while a panel is open — the poll loop skips the render otherwise. */
  open(): boolean {
    return this.panel !== null;
  }

  /** Hand the panel a new frame. Silent when nothing is open to draw on. */
  update(snapshot: HostSnapshot): void {
    this.snapshot = snapshot;
    if (this.panel !== null) this.paint();
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = null;
  }

  private paint(): void {
    if (this.panel === null || this.snapshot === null) return;
    this.panel.webview.html = renderDashboardHtml(this.snapshot);
  }
}
