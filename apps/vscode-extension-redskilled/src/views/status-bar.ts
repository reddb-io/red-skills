/**
 * status-bar — the statusline, in the one place an editor already keeps one.
 *
 * It has one job: put the daemon's header line where the operator can see it
 * without opening anything. Every question about WHAT the line says was already
 * answered in `model/dashboard-view.ts` by a pure function reading a document the
 * daemon rendered, so this file holds no layout logic to test and no branch a
 * test would have to open a window to reach.
 */
import * as vscode from "vscode";
import { statusBarView } from "../model/dashboard-view.js";
import type { HostSnapshot } from "../model/snapshot.js";

export class RedskilledStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(item?: vscode.StatusBarItem) {
    this.item =
      item ?? vscode.window.createStatusBarItem("redskilled.statusline", vscode.StatusBarAlignment.Left, 100);
    this.item.name = "redskilled";
    this.item.command = "redskilled.showDashboard";
    this.item.show();
  }

  /** Hand the bar a new frame; it re-reads the daemon's own summary from it. */
  update(snapshot: HostSnapshot): void {
    const view = statusBarView(snapshot);
    this.item.text = view.text;
    this.item.tooltip = view.tooltip;
    // State is carried by the warning glyph and text. The status bar stays in
    // the editor's own chrome rather than borrowing a green/yellow state slot.
    this.item.backgroundColor = undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
