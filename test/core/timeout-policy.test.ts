import { describe, expect, it } from "vitest";
import type { TaskSpec } from "../../src/contract.js";
import { effectiveBgTimeoutMs, effectiveNotifyLevel, planTimers } from "../../src/core/timeout-policy.js";

const spec = (o: Partial<TaskSpec>): TaskSpec => ({
  command: "x", cwd: "/", hardTimeoutMs: null, bgTimeoutMs: 30_000, notify: "done", startInBackground: false, ...o,
});

describe("effectiveBgTimeoutMs", () => {
  it("call beats session beats config", () => {
    expect(effectiveBgTimeoutMs({ callSeconds: 5, sessionSeconds: 10, configSeconds: 30 })).toBe(5000);
    expect(effectiveBgTimeoutMs({ sessionSeconds: 10, configSeconds: 30 })).toBe(10_000);
    expect(effectiveBgTimeoutMs({ configSeconds: 30 })).toBe(30_000);
  });
  it("0 at any layer means never (null) and wins over lower layers", () => {
    expect(effectiveBgTimeoutMs({ callSeconds: 0, sessionSeconds: 10, configSeconds: 30 })).toBeNull();
    expect(effectiveBgTimeoutMs({ sessionSeconds: 0, configSeconds: 30 })).toBeNull();
    expect(effectiveBgTimeoutMs({ configSeconds: 0 })).toBeNull();
  });
  it("negative control: invalid layers are skipped, not treated as 0", () => {
    expect(effectiveBgTimeoutMs({ callSeconds: -1, sessionSeconds: Number.NaN, configSeconds: 30 })).toBe(30_000);
    expect(effectiveBgTimeoutMs({ callSeconds: Infinity, configSeconds: 7 })).toBe(7000);
  });
  it("rounds fractional seconds up to whole ms", () => {
    expect(effectiveBgTimeoutMs({ callSeconds: 0.0005, configSeconds: 30 })).toBe(1);
    expect(effectiveBgTimeoutMs({ callSeconds: 1.5, configSeconds: 30 })).toBe(1500);
  });
});

describe("effectiveNotifyLevel", () => {
  it("call > session > config", () => {
    expect(effectiveNotifyLevel({ call: "off", session: "error", config: "done" })).toBe("off");
    expect(effectiveNotifyLevel({ session: "error", config: "done" })).toBe("error");
    expect(effectiveNotifyLevel({ config: "done" })).toBe("done");
  });
});

describe("planTimers", () => {
  it("bg timeout only", () => {
    expect(planTimers(spec({}))).toEqual({ handoffInMs: 30_000, killInMs: null });
  });
  it("hard timeout larger than bg timeout gives both", () => {
    expect(planTimers(spec({ hardTimeoutMs: 120_000 }))).toEqual({ handoffInMs: 30_000, killInMs: 120_000 });
  });
  it("bg >= hard disables handoff, kill stays", () => {
    expect(planTimers(spec({ hardTimeoutMs: 30_000 }))).toEqual({ handoffInMs: null, killInMs: 30_000 });
    expect(planTimers(spec({ hardTimeoutMs: 10_000 }))).toEqual({ handoffInMs: null, killInMs: 10_000 });
  });
  it("bg just under hard still hands off", () => {
    expect(planTimers(spec({ hardTimeoutMs: 30_001 }))).toEqual({ handoffInMs: 30_000, killInMs: 30_001 });
  });
  it("null or 0 bg timeout never hands off", () => {
    expect(planTimers(spec({ bgTimeoutMs: null })).handoffInMs).toBeNull();
    expect(planTimers(spec({ bgTimeoutMs: 0 })).handoffInMs).toBeNull();
  });
  it("startInBackground has no handoff timer but keeps the kill timer", () => {
    expect(planTimers(spec({ startInBackground: true, hardTimeoutMs: 5000 }))).toEqual({ handoffInMs: null, killInMs: 5000 });
  });
  it("non-positive or non-finite hard timeout means none; fractions round up", () => {
    expect(planTimers(spec({ hardTimeoutMs: 0 })).killInMs).toBeNull();
    expect(planTimers(spec({ hardTimeoutMs: Number.NaN })).killInMs).toBeNull();
    expect(planTimers(spec({ hardTimeoutMs: 100_000.2, bgTimeoutMs: 1000.1 }))).toEqual({ handoffInMs: 1001, killInMs: 100_001 });
  });
});
