import { describe, expect, it } from "vitest";
import { appendSummaryField, decode, encode, projectFields } from "./index.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const quoteForcingStrings = [
  "",
  "007",
  "true",
  "false",
  "null",
  "has: colon",
  'quote " mark',
  "slash \\ mark",
  "array[0]",
  "object{key}",
  "a,b",
  "-dash",
  "line\nbreak",
  "tab\tbreak",
  "unicode caf\u00e9",
  "control\u0001char",
];

function generatedJson(rng: () => number, depth = 0): JsonValue {
  if (depth > 3) return generatedScalar(rng);
  const kind = Math.floor(rng() * 6);
  if (kind <= 2) return generatedScalar(rng);
  if (kind === 3) {
    const length = Math.floor(rng() * 4);
    return Array.from({ length }, () => generatedJson(rng, depth + 1));
  }
  const fields = ["id", "name", "active", "note"].slice(0, 1 + Math.floor(rng() * 4));
  const rowCount = Math.floor(rng() * 4);
  if (kind === 4) {
    return Array.from({ length: rowCount }, (_, index) =>
      Object.fromEntries(fields.map((field) => [field, field === "id" ? index + 1 : generatedScalar(rng)])),
    );
  }
  return Object.fromEntries(fields.map((field) => [field, generatedJson(rng, depth + 1)]));
}

function generatedScalar(rng: () => number): JsonPrimitive {
  const kind = Math.floor(rng() * 5);
  if (kind === 0) return null;
  if (kind === 1) return rng() > 0.5;
  if (kind === 2) return Math.floor(rng() * 10_000) - 5_000;
  if (kind === 3) return quoteForcingStrings[Math.floor(rng() * quoteForcingStrings.length)] ?? "";
  return `text-${Math.floor(rng() * 1000)}`;
}

describe("shared TOON package", () => {
  it("round-trips generated JSON-shaped values through the public encoder and decoder", () => {
    const rng = makeRng(0x5eed);
    const cases = [
      null,
      "",
      "unicode caf\u00e9",
      "has: colon",
      { empty: "", nil: null, nested: { active: true } },
      { rows: [{ id: 1, value: "a,b" }, { id: 2, value: "-dash" }] },
      ...Array.from({ length: 80 }, () => generatedJson(rng)),
    ];

    for (const value of cases) {
      expect(decode(encode(value))).toEqual(value);
    }
  });

  it("emits exact spec-v3.2 fixture bytes for RedSkills-supported forms", () => {
    expect(encode({ users: [{ id: 1, name: "Alice", active: true }, { id: 2, name: "Bob", active: false }] })).toBe(
      ["users[2]{id,name,active}:", "  1,Alice,true", "  2,Bob,false"].join("\n"),
    );
    expect(encode({ project: { id: "p1", meta: { owner: "ops", ok: true } } })).toBe(
      ["project:", "  id: p1", "  meta:", "    owner: ops", "    ok: true"].join("\n"),
    );
    expect(encode("hello")).toBe("hello");
    expect(encode({ obj: {}, arr: [] })).toBe(["obj:", "arr: []"].join("\n"));
    expect(encode({ rows: [{ value: "a,b" }, { value: "-dash" }, { value: "true" }, { value: "null" }] })).toBe(
      ['rows[4]{value}:', '  "a,b"', '  "-dash"', '  "true"', '  "null"'].join("\n"),
    );
    expect(encode({ text: 'backslash \\ quote " newline\ncarriage\r tab\t nul\u0001' })).toBe(
      'text: "backslash \\\\ quote \\" newline\\ncarriage\\r tab\\t nul\\u0001"',
    );
    expect(encode({ rows: [{ value: "a|b" }, { value: "a,b" }] }, { delimiter: "|" })).toBe(
      ['rows[2|]{value}:', '  "a|b"', "  a,b"].join("\n"),
    );
  });

  it("enforces strict [N] length agreement while decoding", () => {
    expect(() => decode(["rows[2]{id}:", "  1"].join("\n"))).toThrow(/Expected 2 tabular rows, but got 1/);
  });

  it("appends a pre-computed rollup as a trailing summary field in the same document", () => {
    const output = appendSummaryField({ rows: [{ id: 1, status: "ok" }] }, "1 row ok");

    expect(output).toBe(["rows[1]{id,status}:", "  1,ok", "summary: 1 row ok"].join("\n"));
    expect(decode(output)).toEqual({ rows: [{ id: 1, status: "ok" }], summary: "1 row ok" });
  });

  it("projects object arrays onto an explicit field allowlist in allowlist order", () => {
    expect(projectFields([{ id: 1, name: "Alice", secret: "drop", status: "active" }], ["status", "id"])).toEqual([
      { status: "active", id: 1 },
    ]);
  });
});
