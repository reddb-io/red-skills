import { describe, expect, it } from "vitest";
import { createActivityMeter } from "../src/core/activity-meter.js";

describe("createActivityMeter", () => {
  it("counts toolCall and text events independently", () => {
    const m = createActivityMeter();
    m.record({ type: "toolCall" });
    m.record({ type: "text" });
    m.record({ type: "toolCall" });
    const s = m.peek();
    expect(s.toolsCalled).toBe(2);
    expect(s.textChunks).toBe(1);
  });

  it("a window with new events does NOT increment waiting", () => {
    const m = createActivityMeter();
    m.record({ type: "toolCall" });
    const s = m.snapshotWindow();
    expect(s.eventsThisWindow).toBe(1);
    expect(s.waiting).toBe(0);
    expect(s.toolsCalled).toBe(1);
  });

  it("a window with ZERO new events increments waiting (the blocked/hung signal)", () => {
    const m = createActivityMeter();
    m.record({ type: "text" });
    m.snapshotWindow(); // window 1: 1 event → not waiting
    const s2 = m.snapshotWindow(); // window 2: no new events → waiting
    expect(s2.eventsThisWindow).toBe(0);
    expect(s2.waiting).toBe(1);
    const s3 = m.snapshotWindow(); // window 3: still nothing → waiting again
    expect(s3.waiting).toBe(2);
  });

  it("waiting only counts windows, not events: a busy window resets the streak", () => {
    const m = createActivityMeter();
    m.snapshotWindow(); // empty → waiting 1
    m.record({ type: "toolCall" });
    const busy = m.snapshotWindow(); // has an event → waiting stays 1
    expect(busy.waiting).toBe(1);
    expect(busy.eventsThisWindow).toBe(1);
    const idle = m.snapshotWindow(); // empty again → waiting 2
    expect(idle.waiting).toBe(2);
  });

  it("cumulative counts survive across windows", () => {
    const m = createActivityMeter();
    m.record({ type: "toolCall" });
    m.snapshotWindow();
    m.record({ type: "toolCall" });
    m.record({ type: "text" });
    const s = m.snapshotWindow();
    expect(s.toolsCalled).toBe(2);
    expect(s.textChunks).toBe(1);
    expect(s.eventsThisWindow).toBe(2);
  });

  it("peek does not advance the window boundary", () => {
    const m = createActivityMeter();
    m.record({ type: "text" });
    expect(m.peek().eventsThisWindow).toBe(1);
    expect(m.peek().eventsThisWindow).toBe(1); // unchanged — peek is read-only
    expect(m.peek().waiting).toBe(0);
  });
});
