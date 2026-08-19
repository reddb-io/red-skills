import { describe, expect, it } from "vitest";
import {
  normalizeWorkConfig,
  parseWorkSelector,
  WorkSelectorValidationError,
} from "./work-selector.js";

describe("work selector parsing", () => {
  it("accepts tags and user facets, deduping tag values", () => {
    expect(parseWorkSelector({ tags: ["backend", "backend", "infra"], user: "@me" })).toEqual({
      tags: ["backend", "infra"],
      user: "@me",
    });
  });

  it("keeps an empty selector as the whole backlog rather than dropping it", () => {
    expect(parseWorkSelector({})).toEqual({});
    expect(parseWorkSelector(undefined)).toEqual({});
  });

  it("narrows on spec, lane, label and issues", () => {
    expect(parseWorkSelector({ spec: 12, lane: "go", label: "type:bug", issues: [3, 4] })).toEqual({
      spec: 12,
      lane: "go",
      label: "type:bug",
      issues: [3, 4],
    });
  });

  it("rejects malformed tags: non-arrays, empties, prefixes, and non-label shapes", () => {
    expect(() => parseWorkSelector({ tags: "backend" })).toThrow(WorkSelectorValidationError);
    expect(() => parseWorkSelector({ tags: [] })).toThrow(WorkSelectorValidationError);
    expect(() => parseWorkSelector({ tags: ["tag:backend"] })).toThrow(WorkSelectorValidationError);
    expect(() => parseWorkSelector({ tags: ["Backend"] })).toThrow(WorkSelectorValidationError);
  });

  it("rejects a non-object selector and malformed scalar facets", () => {
    expect(() => parseWorkSelector(["backend"])).toThrow(WorkSelectorValidationError);
    expect(() => parseWorkSelector({ spec: 0 })).toThrow(WorkSelectorValidationError);
    expect(() => parseWorkSelector({ lane: "" })).toThrow(WorkSelectorValidationError);
    expect(() => parseWorkSelector({ issues: [0] })).toThrow(WorkSelectorValidationError);
  });
});

describe("work config overrides", () => {
  it("keeps scalars and collapses an empty bag", () => {
    expect(normalizeWorkConfig({ target: 3, runner: "claude", verbose: true })).toEqual({
      target: 3,
      runner: "claude",
      verbose: true,
    });
    expect(normalizeWorkConfig({})).toBeUndefined();
    expect(normalizeWorkConfig(undefined)).toBeUndefined();
  });

  it("rejects a nested value", () => {
    expect(() => normalizeWorkConfig({ nested: { a: 1 } })).toThrow(WorkSelectorValidationError);
  });
});
