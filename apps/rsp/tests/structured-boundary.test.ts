import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { renderStructuredBoundary, renderStructuredContract } from "../src/structured-boundary.js";

describe("rsp lossless structured-data boundary", () => {
  it("emits canonical TOON for nested JSON only after proving the data model round-trips", () => {
    const value = {
      service: "api",
      healthy: true,
      replicas: [{ id: 1, tags: ["edge", "primary"] }, { id: 2, tags: [] }],
      metadata: { owner: "platform", note: null },
    };
    const original = Buffer.from(JSON.stringify(value, null, 2));

    const rendered = renderStructuredBoundary(original);

    expect(rendered).not.toEqual(original);
    expect(decode(rendered.toString("utf8"))).toEqual(value);
  });

  it.each([
    ["scalar", '"ready"', "ready"],
    ["tabular", '[{"name":"api","latency_ms":12},{"name":"worker","latency_ms":0}]', [{ name: "api", latency_ms: 12 }, { name: "worker", latency_ms: 0 }]],
    ["Unicode", '{"greeting":"Olá 世界","emoji":"🧪"}', { greeting: "Olá 世界", emoji: "🧪" }],
    ["empty object", "{}", {}],
    ["empty array", "[]", []],
    ["empty scalar", '""', ""],
    ["numeric edges", '{"safe_integer":9007199254740991,"exponent":1e-7}', { safe_integer: 9_007_199_254_740_991, exponent: 1e-7 }],
  ])("round-trips %s JSON values", (_name, input, expected) => {
    const rendered = renderStructuredBoundary(Buffer.from(input));

    expect(decode(rendered.toString("utf8"))).toEqual(expected);
  });

  it("passes through a negative-zero numeric edge that canonical TOON cannot preserve", () => {
    const original = Buffer.from('{"negative_zero":-0}\n');

    expect(renderStructuredBoundary(original)).toEqual(original);
  });

  it("preserves already-canonical TOON bytes after proving its decoded model", () => {
    const original = Buffer.from("service: api\nreplicas[2]: 1,2\n");

    const rendered = renderStructuredBoundary(original);

    expect(rendered).toEqual(original);
    expect(decode(rendered.toString("utf8"))).toEqual({ service: "api", replicas: [1, 2] });
  });

  it("decodes a TOONL table and emits its complete record set as canonical TOON", () => {
    const original = Buffer.from("[]{name,ok}:\napi,true\nworker,false\n[=2]\n");

    const rendered = renderStructuredBoundary(original);

    expect(decode(rendered.toString("utf8"))).toEqual([
      { name: "api", ok: true },
      { name: "worker", ok: false },
    ]);
  });

  it.each([
    ["nested YAML", "service: api\nports:\n  - 80\n  - 443\nmetadata:\n  owner: platform\n  enabled: true\n", { service: "api", ports: [80, 443], metadata: { owner: "platform", enabled: true } }],
    ["explicit YAML scalar", "---\nready\n", "ready"],
    ["flow-style YAML", "{service: api, ports: [80, 443]}\n", { service: "api", ports: [80, 443] }],
    ["quoted YAML scalar", "'ready'\n", "ready"],
  ])("emits canonical TOON for %s after proving the YAML data model", (_name, input, expected) => {
    const rendered = renderStructuredBoundary(Buffer.from(input));

    expect(rendered).not.toEqual(Buffer.from(input));
    expect(decode(rendered.toString("utf8"))).toEqual(expected);
  });

  it.each([
    ["invalid structure", Buffer.from('{"broken":')],
    ["ambiguous multi-document input", Buffer.from("---\na: 1\n---\nb: 2\n")],
    ["ambiguous structured-plus-prose output", Buffer.from("command: git log\nsummary: 12 commits\n… elided 11 rows — rsp show el:123456789abc\n")],
    ["prose", Buffer.from("Deployment completed successfully. No follow-up action is required.\n")],
    ["binary bytes", Buffer.from([0, 255, 10, 13])],
  ])("keeps %s byte-identical", (_name, original) => {
    expect(renderStructuredBoundary(original)).toEqual(original);
  });

  it.each([
    ["encoding throws", { encode: () => { throw new Error("fixture encode failure"); } }],
    ["proof decoding throws", { decode: () => { throw new Error("fixture decode failure"); } }],
    ["proof changes the model", { decode: () => ({ changed: true }) }],
  ])("preserves the completed command contract when %s", (_name, dependencies) => {
    const contract = {
      stdout: Buffer.from('{"ok":true}'),
      stderr: Buffer.from("native diagnostic\n"),
      status: 19,
      signal: null,
    } as const;

    expect(renderStructuredContract(contract, dependencies)).toEqual(contract);
  });

  it("keeps XML byte-identical when tq cannot complete the round-trip proof", () => {
    const original = Buffer.from("<root/>");

    expect(renderStructuredBoundary(original, { runTq: () => undefined })).toEqual(original);
  });

  it("keeps XML byte-identical when tq's round-trip changes the canonical tree", () => {
    const original = Buffer.from("<root/>");
    const conversions = [
      "xml:\n  declaration: null\n  children[1]:\n    - type: element\n      name: root\n      attributes: []\n      children: []\n      empty: true\n",
      "<root></root>\n",
      "xml:\n  declaration: null\n  children[1]:\n    - type: element\n      name: root\n      attributes: []\n      children: []\n      empty: false\n",
    ];

    expect(renderStructuredBoundary(original, { runTq: () => conversions.shift() })).toEqual(original);
  });
});
