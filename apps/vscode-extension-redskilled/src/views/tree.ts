/**
 * tree — one `TreeDataProvider` for all three views.
 *
 * It has one job: turn a `ViewNode` into a `TreeItem`. Every question about WHAT
 * a row says was already answered in `model/nodes.ts` by a pure function, so this
 * file holds no layout logic to test and no branch that a test would have to open
 * a window to reach.
 *
 * The three views differ only by which builder they were constructed with, which
 * is why there is one class here and not three.
 */
import * as vscode from "vscode";
import type { ViewNode } from "../model/nodes.js";
import type { HostSnapshot } from "../model/snapshot.js";

export type NodeBuilder = (snapshot: HostSnapshot) => readonly ViewNode[];

export class RedskilledTreeProvider implements vscode.TreeDataProvider<ViewNode> {
  private readonly changed = new vscode.EventEmitter<ViewNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private snapshot: HostSnapshot | null = null;

  constructor(private readonly build: NodeBuilder) {}

  /** Hand the provider a new frame; the view refreshes from it. */
  update(snapshot: HostSnapshot): void {
    this.snapshot = snapshot;
    this.changed.fire(undefined);
  }

  getChildren(element?: ViewNode): ViewNode[] {
    if (element) return [...element.children];
    if (this.snapshot === null) return [];
    return [...this.build(this.snapshot)];
  }

  getTreeItem(node: ViewNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = `redskilled.${node.kind}`;
    item.iconPath = iconFor(node);
    if (node.kind === "worker") {
      item.command = {
        command: "redskilled.showWorkerLog",
        title: "Show this Worker's log",
        arguments: [node],
      };
    }
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/**
 * The icon a row carries, chosen from its kind and its tone.
 *
 * Tone wins over kind: a Worker at 97% of its ceiling should not look like every
 * other Worker just because it is one.
 */
function iconFor(node: ViewNode): vscode.ThemeIcon {
  if (node.tone === "error") return new vscode.ThemeIcon("error");
  if (node.tone === "warning") return new vscode.ThemeIcon("warning");
  switch (node.kind) {
    case "worker":
      return new vscode.ThemeIcon("server-process");
    case "host":
      return new vscode.ThemeIcon("server");
    case "event":
      return new vscode.ThemeIcon("history");
    case "metric":
      return new vscode.ThemeIcon("pulse");
    case "repository":
      return new vscode.ThemeIcon("git-pull-request");
    case "absence":
      return new vscode.ThemeIcon("circle-slash");
    default:
      return new vscode.ThemeIcon("dash");
  }
}
