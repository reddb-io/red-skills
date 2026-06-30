import { describe, it, expect } from "vitest";
import { buildA11yTree } from "../a11y.js";
import type { CdpAXNode } from "../types.js";

function makeCounter(): () => number {
  let n = 0;
  return () => ++n;
}

describe("buildA11yTree", () => {
  it("assigns sequential refs depth-first", () => {
    const nodes: CdpAXNode[] = [
      { nodeId: "1", role: { value: "WebArea" }, name: { value: "page" }, childIds: ["2", "3"] },
      { nodeId: "2", role: { value: "heading" }, name: { value: "Title" }, childIds: [] },
      { nodeId: "3", role: { value: "button" }, name: { value: "Submit" }, childIds: [] },
    ];

    const { tree, refSet } = buildA11yTree(nodes, makeCounter());
    expect(tree).toHaveLength(1);
    expect(tree[0].ref).toBe(1);
    expect(tree[0].role).toBe("WebArea");
    expect(tree[0].children[0].ref).toBe(2);
    expect(tree[0].children[0].role).toBe("heading");
    expect(tree[0].children[1].ref).toBe(3);
    expect(refSet.size).toBe(3);
    expect(refSet.has(1)).toBe(true);
    expect(refSet.has(2)).toBe(true);
    expect(refSet.has(3)).toBe(true);
  });

  it("filters ignored nodes and their subtrees", () => {
    const nodes: CdpAXNode[] = [
      { nodeId: "1", role: { value: "WebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", role: { value: "generic" }, ignored: true, childIds: ["4"] },
      { nodeId: "3", role: { value: "button" }, name: { value: "OK" }, childIds: [] },
      { nodeId: "4", role: { value: "text" }, name: { value: "hidden" }, childIds: [] },
    ];

    const { tree, refSet } = buildA11yTree(nodes, makeCounter());
    const root = tree[0];
    expect(root.children).toHaveLength(1);
    expect(root.children[0].role).toBe("button");
    expect(refSet.size).toBe(2);
  });

  it("includes description and value when present", () => {
    const nodes: CdpAXNode[] = [
      {
        nodeId: "1",
        role: { value: "textbox" },
        name: { value: "Email" },
        description: { value: "Enter your email" },
        value: { value: "user@example.com" },
        childIds: [],
      },
    ];

    const { tree } = buildA11yTree(nodes, makeCounter());
    expect(tree[0].description).toBe("Enter your email");
    expect(tree[0].value).toBe("user@example.com");
  });

  it("returns multiple roots when nodes have no common parent", () => {
    const nodes: CdpAXNode[] = [
      { nodeId: "a", role: { value: "header" }, childIds: [] },
      { nodeId: "b", role: { value: "main" }, childIds: [] },
    ];

    const { tree } = buildA11yTree(nodes, makeCounter());
    expect(tree).toHaveLength(2);
  });

  it("refSet contains exactly the non-ignored nodes", () => {
    const nodes: CdpAXNode[] = [
      { nodeId: "1", role: { value: "doc" }, childIds: ["2"] },
      { nodeId: "2", role: { value: "link" }, childIds: [] },
    ];

    const counter = makeCounter();
    const { refSet } = buildA11yTree(nodes, counter);
    expect(refSet.size).toBe(2);
  });
});

describe("stale-ref detection contract", () => {
  it("a ref absent from refSet is stale", () => {
    const nodes: CdpAXNode[] = [
      { nodeId: "1", role: { value: "button" }, name: { value: "Save" }, childIds: [] },
    ];

    const counter = makeCounter();
    const { refSet } = buildA11yTree(nodes, counter);

    const presentRef = refSet.values().next().value as number;
    const staleRef = presentRef + 999;

    expect(refSet.has(presentRef)).toBe(true);
    expect(refSet.has(staleRef)).toBe(false);
  });

  it("ref from an old snapshot is stale in the new one", () => {
    const snap1Nodes: CdpAXNode[] = [
      { nodeId: "1", role: { value: "button" }, name: { value: "Old" }, childIds: [] },
    ];
    const snap2Nodes: CdpAXNode[] = [
      { nodeId: "2", role: { value: "button" }, name: { value: "New" }, childIds: [] },
    ];

    let c = 0;
    const counter = () => ++c;

    const { refSet: snap1Refs } = buildA11yTree(snap1Nodes, counter);
    const { refSet: snap2Refs } = buildA11yTree(snap2Nodes, counter);

    const oldRef = snap1Refs.values().next().value as number;
    expect(snap2Refs.has(oldRef)).toBe(false);
  });
});
