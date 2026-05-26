import { describe, expect, test } from "vitest";
import {
  CONFLICT_NODE_TYPES,
  detectConflicts,
  type ConflictNode,
} from "../src/conflict-detector.js";
import type { NodeType } from "../src/schema.js";

function node(
  rid: number | undefined,
  partial: Partial<ConflictNode> & {
    label: string;
    node_type: NodeType;
    title?: string;
    content?: string;
    summary?: string;
    session?: string;
    hash?: string;
    tags?: string[];
  },
): ConflictNode {
  return {
    rid,
    label: partial.label,
    node_type: partial.node_type,
    properties: {
      title: partial.title ?? partial.label,
      ...(partial.content !== undefined ? { content: partial.content } : {}),
      ...(partial.summary !== undefined ? { summary: partial.summary } : {}),
      ...(partial.tags !== undefined ? { tags: partial.tags } : {}),
      ...(partial.hash !== undefined ? { hash: partial.hash } : {}),
      ...(partial.session !== undefined
        ? {
            scope: "session" as const,
            scope_id: partial.session,
            provenance: {
              source_kind: "manual" as const,
              scope: { level: "session" as const, id: partial.session },
            },
          }
        : {}),
    },
  };
}

describe("ConflictDetector (pure)", () => {
  test("same-fact-different-value: same topic, different value", () => {
    const candidate = node(undefined, {
      label: "auth-token-storage",
      node_type: "decision",
      title: "auth token storage location",
      content: "store auth tokens in httpOnly cookies",
      session: "sess-A",
    });
    const existing = [
      node(10, {
        label: "auth-token-storage",
        node_type: "decision",
        title: "auth token storage location",
        content: "persist auth tokens in localStorage for sso bridge",
        session: "sess-B",
      }),
    ];
    const conflicts = detectConflicts(candidate, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("same-fact-different-value");
    expect(conflicts[0]?.rid).toBe(10);
    expect(conflicts[0]?.sessions).toEqual({
      candidate: "sess-A",
      existing: "sess-B",
    });
  });

  test("semantically-opposite: polarity flip on same topic", () => {
    const candidate = node(undefined, {
      label: "retry-policy",
      node_type: "decision",
      title: "retry policy for outbound webhooks",
      content: "always retry failed webhooks with exponential backoff",
      session: "sess-A",
    });
    const existing = [
      node(20, {
        label: "retry-policy",
        node_type: "decision",
        title: "retry policy for outbound webhooks",
        content: "do not retry failed webhooks with exponential backoff",
        session: "sess-B",
      }),
    ];
    const conflicts = detectConflicts(candidate, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("semantically-opposite");
    expect(conflicts[0]?.rid).toBe(20);
  });

  test("same-text-different-session: identical hash, different sessions", () => {
    const candidate = node(undefined, {
      label: "rate-limit-strategy",
      node_type: "decision",
      title: "rate limit strategy",
      content: "use token bucket with 100 rps burst",
      hash: "deadbeef",
      session: "sess-A",
    });
    const existing = [
      node(30, {
        label: "rate-limit-strategy",
        node_type: "decision",
        title: "rate limit strategy",
        content: "use token bucket with 100 rps burst",
        hash: "deadbeef",
        session: "sess-B",
      }),
    ];
    const conflicts = detectConflicts(candidate, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe("same-text-different-session");
    expect(conflicts[0]?.sessions).toEqual({
      candidate: "sess-A",
      existing: "sess-B",
    });
  });

  test("no-conflict-distinct-claims: different topic produces no edge", () => {
    const candidate = node(undefined, {
      label: "metrics-backend",
      node_type: "decision",
      title: "metrics backend choice",
      content: "use prometheus for app metrics",
      session: "sess-A",
    });
    const existing = [
      node(40, {
        label: "billing-currency",
        node_type: "decision",
        title: "billing currency",
        content: "store billing amounts in cents as integers",
        session: "sess-B",
      }),
      node(41, {
        label: "deploy-region",
        node_type: "decision",
        title: "default deploy region",
        content: "deploy first to us-east-1",
        session: "sess-A",
      }),
    ];
    expect(detectConflicts(candidate, existing)).toEqual([]);
  });

  test("does not flag conflicts against non-conflict node types", () => {
    const candidate = node(undefined, {
      label: "user-service",
      node_type: "file",
      title: "user-service.ts",
      content: "exports class UserService",
    });
    const existing = [
      node(50, {
        label: "user-service",
        node_type: "file",
        title: "user-service.ts",
        content: "exports default function UserService",
      }),
    ];
    expect(detectConflicts(candidate, existing)).toEqual([]);
  });

  test("does not flag conflicts across different node_types", () => {
    const candidate = node(undefined, {
      label: "x",
      node_type: "decision",
      title: "x",
      content: "do x",
      session: "sess-A",
    });
    const existing = [
      node(60, {
        label: "x",
        node_type: "fix",
        title: "x",
        content: "do not do x",
        session: "sess-B",
      }),
    ];
    expect(detectConflicts(candidate, existing)).toEqual([]);
  });

  test("skips identical hash from the same session (pure duplicate)", () => {
    const candidate = node(undefined, {
      label: "queue-depth",
      node_type: "decision",
      title: "queue depth",
      content: "cap queue at 10000 messages",
      hash: "cafef00d",
      session: "sess-A",
    });
    const existing = [
      node(70, {
        label: "queue-depth",
        node_type: "decision",
        title: "queue depth",
        content: "cap queue at 10000 messages",
        hash: "cafef00d",
        session: "sess-A",
      }),
    ];
    expect(detectConflicts(candidate, existing)).toEqual([]);
  });

  test("deterministic ordering: results follow input order", () => {
    const candidate = node(undefined, {
      label: "cache-policy",
      node_type: "decision",
      title: "cache policy",
      content: "cache responses for 60 seconds",
      session: "sess-A",
    });
    const existing = [
      node(101, {
        label: "cache-policy",
        node_type: "decision",
        title: "cache policy",
        content: "never cache responses, always hit origin",
        session: "sess-B",
      }),
      node(102, {
        label: "cache-policy",
        node_type: "decision",
        title: "cache policy",
        content: "bypass caching layer entirely for dynamic endpoints",
        session: "sess-C",
      }),
    ];
    const a = detectConflicts(candidate, existing).map((c) => [c.rid, c.kind]);
    const b = detectConflicts(candidate, existing).map((c) => [c.rid, c.kind]);
    expect(a).toEqual(b);
    expect(a[0]?.[0]).toBe(101);
    expect(a[1]?.[0]).toBe(102);
  });

  test("CONFLICT_NODE_TYPES is non-empty and includes Decision and Fix", () => {
    expect(CONFLICT_NODE_TYPES.size).toBeGreaterThan(0);
    expect(CONFLICT_NODE_TYPES.has("decision")).toBe(true);
    expect(CONFLICT_NODE_TYPES.has("fix")).toBe(true);
  });
});
