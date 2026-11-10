import { afterEach, describe, expect, it, vi } from "vitest";
import { createUi } from "../../src/pi/ui.js";
import { w7Ctx, w7Setup, w7Spec } from "./w7-helpers.js";

function setup(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const s = w7Setup();
  const ui = createUi(s.pi.asExtensionAPI(), { registry: s.registry });
  const ctx = w7Ctx(s.pi, mode);
  ui.onSessionStart(ctx);
  const lastStatus = () => s.pi.ui.statuses.at(-1)?.text;
  // registry.create() notifies no subscriber (only dispatch does); the task starter calls ui.refresh() after it.
  const create = (over: Parameters<typeof w7Spec>[0] = {}) => {
    const task = s.registry.create(w7Spec(over));
    ui.refresh();
    return task;
  };
  return { ...s, ui, ctx, lastStatus, create };
}

afterEach(() => vi.restoreAllMocks());

describe("createUi", () => {
  it("shows nothing with no tasks", () => {
    const t = setup();
    expect(t.pi.ui.widgets).toEqual([]);
    expect(t.pi.ui.statuses).toEqual([]);
    expect(t.clock.pending()).toBe(0);
  });

  it("shows k shells in the status line while background tasks run, and nothing else", () => {
    const t = setup();
    const a = t.create({ startInBackground: true });
    expect(t.lastStatus()).toBe("1 shell");
    t.create({ startInBackground: true });
    expect(t.lastStatus()).toBe("2 shells");
    expect(t.pi.ui.statuses.at(-1)?.key).toBe("pi-bg");
    expect(t.pi.ui.widgets).toEqual([]);
    t.registry.dispatch(a.id, { type: "exit", code: 0, signal: null, at: t.clock.now() });
    expect(t.lastStatus()).toBe("1 shell");
    expect(t.clock.pending()).toBe(0);
  });

  it("does not rewrite unchanged output on a refresh", () => {
    const t = setup();
    t.create({ startInBackground: true });
    const n = t.pi.ui.statuses.length;
    t.ui.refresh();
    expect(t.pi.ui.statuses).toHaveLength(n);
  });

  it("forwards only the status string in rpc mode", () => {
    const t = setup("rpc");
    t.create({ startInBackground: true });
    expect(t.lastStatus()).toBe("1 shell");
    expect(t.pi.ui.widgets).toEqual([]);
    expect(t.clock.pending()).toBe(0);
  });

  it.each(["json", "print"] as const)("touches no UI in %s mode", (mode) => {
    const t = setup(mode);
    t.create({ startInBackground: true });
    expect(t.pi.ui.widgets).toEqual([]);
    expect(t.pi.ui.statuses).toEqual([]);
  });

  it("dispose clears the status and stops reacting to the registry", () => {
    const t = setup();
    t.create({ startInBackground: true });
    t.ui.dispose();
    expect(t.lastStatus()).toBeUndefined();
    const n = t.pi.ui.statuses.length;
    t.create({ startInBackground: true });
    expect(t.pi.ui.statuses).toHaveLength(n);
  });

  it("onSessionStart twice does not double-subscribe", () => {
    const t = setup();
    t.ui.onSessionStart(t.ctx);
    t.create({ startInBackground: true });
    expect(t.pi.ui.statuses.filter((s) => s.text === "1 shell")).toHaveLength(1);
  });

  describe("notify", () => {
    it("uses ctx.ui.notify in tui and rpc", () => {
      for (const mode of ["tui", "rpc"] as const) {
        const t = setup(mode);
        t.ui.notify("hello", "warning");
        expect(t.pi.ui.notices).toEqual([{ msg: "hello", level: "warning" }]);
      }
    });

    it.each(["json", "print"] as const)("writes to stderr in %s mode", (mode) => {
      const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const t = setup(mode);
      t.ui.notify("hello", "error");
      expect(t.pi.ui.notices).toEqual([]);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("hello"));
    });
  });
});
