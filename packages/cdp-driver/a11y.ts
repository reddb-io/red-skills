import type { A11yNode, CdpAXNode } from "./types.js";

export function buildA11yTree(
  nodes: CdpAXNode[],
  nextRef: () => number,
): { tree: A11yNode[]; refSet: Set<number> } {
  const byId = new Map<string, CdpAXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const childSet = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) childSet.add(c);
  }

  const refSet = new Set<number>();

  function buildNode(nodeId: string): A11yNode | null {
    const node = byId.get(nodeId);
    if (!node || node.ignored) return null;
    const ref = nextRef();
    refSet.add(ref);
    const children: A11yNode[] = [];
    for (const childId of node.childIds ?? []) {
      const child = buildNode(childId);
      if (child) children.push(child);
    }
    const result: A11yNode = {
      ref,
      role: node.role?.value ?? "unknown",
      name: node.name?.value ?? "",
      children,
    };
    if (node.description?.value) result.description = node.description.value;
    if (node.value?.value) result.value = node.value.value;
    return result;
  }

  const roots = nodes.filter((n) => !childSet.has(n.nodeId) && !n.ignored);
  const tree: A11yNode[] = [];
  for (const root of roots) {
    const node = buildNode(root.nodeId);
    if (node) tree.push(node);
  }

  return { tree, refSet };
}
