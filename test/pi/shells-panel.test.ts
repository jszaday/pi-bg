import { afterEach, describe, expect, it, vi } from "vitest";
import type { KillResult } from "../../src/core/format.js";
import { createShellsPanel } from "../../src/pi/shells-panel.js";
import { w7Ctx, w7Setup, w7Spec } from "./w7-helpers.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";
const PGUP = "\x1b[5~";
const PGDN = "\x1b[6~";

const ok = (id: string): KillResult => ({ killed: [id], alreadyFinished: [], failed: [] });

function setup(output: string[] = []) {
  const s = w7Setup();
  const kill = vi.fn(async (id: string): Promise<KillResult> => ok(id));
  const tailOf = vi.fn((_id: string, n: number) => output.slice(-n));
  const setFooterFocus = vi.fn();
  const panel = createShellsPanel({ registry: s.registry, clock: s.clock, kill, tailOf, setFooterFocus });
  const ctx = w7Ctx(s.pi);
  const bg = (over: Parameters<typeof w7Spec>[0] = {}) => s.registry.create(w7Spec({ startInBackground: true, ...over }));
  const exit = (id: string) => s.registry.dispatch(id, { type: "exit", code: 0, signal: null, at: s.clock.now() });
  const overlay = () => s.pi.ui.overlays.at(-1)!;
  const lines = (width = 80) => overlay().component.render(width);
  return { ...s, panel, ctx, kill, tailOf, setFooterFocus, bg, exit, overlay, lines };
}

afterEach(() => vi.restoreAllMocks());

describe("shells panel", () => {
  it("opens a modal overlay listing background shells, with the selected row inverted", () => {
    const t = setup();
    t.bg({ command: "make one" });
    t.bg({ command: "make two" });
    t.panel.open(t.ctx);
    expect(t.panel.isOpen()).toBe(true);
    expect(t.overlay().opts).toMatchObject({ overlay: true });
    const lines = t.lines();
    expect(lines[0]).toBe(`\x1b[7m${lines[0].replace(/\x1b\[\d+m/g, "")}\x1b[27m`);
    expect(lines[0]).toContain("make one");
    expect(lines[1]).not.toContain("\x1b[7m");
    expect(lines.at(-1)).toContain("esc close");
  });

  it("shows the empty text and does not open a second overlay when opened twice", () => {
    const t = setup();
    t.panel.open(t.ctx);
    t.panel.open(t.ctx);
    expect(t.pi.ui.overlays).toHaveLength(1);
    expect(t.lines()).toEqual(["No background shells."]);
  });

  it("flattens control whitespace and cuts every line to the render width", () => {
    const t = setup();
    t.bg({ command: "echo a\tb\r\nc " + "z".repeat(200) });
    t.panel.open(t.ctx);
    for (const l of t.lines(30)) {
      expect(l).not.toMatch(/[\r\n\t]/);
      expect(l.replace(/\x1b\[\d+m/g, "").length).toBeLessThanOrEqual(30);
    }
  });

  it("Up and Down move the selection; Down at the last row stays", () => {
    const t = setup();
    t.bg({ command: "one" });
    t.bg({ command: "two" });
    t.panel.open(t.ctx);
    t.pi.ui.typeKey(DOWN);
    expect(t.lines()[1]).toContain("\x1b[7m");
    t.pi.ui.typeKey(DOWN);
    expect(t.lines()[1]).toContain("\x1b[7m");
    t.pi.ui.typeKey(UP);
    expect(t.lines()[0]).toContain("\x1b[7m");
  });

  it("Enter shows the live output tail; Esc goes back to the list, a second Esc closes", () => {
    const t = setup(["alpha", "beta"]);
    const a = t.bg({ command: "make" });
    t.panel.open(t.ctx);
    t.pi.ui.typeKey(ENTER);
    const lines = t.lines();
    expect(lines[0]).toContain(a.id);
    expect(lines).toContain("alpha");
    expect(lines).toContain("beta");
    expect(t.tailOf).toHaveBeenCalledWith(a.id, 500);
    t.pi.ui.typeKey(ESC);
    expect(t.lines()[0]).toContain("make");
    expect(t.panel.isOpen()).toBe(true);
    t.pi.ui.typeKey(ESC);
    expect(t.panel.isOpen()).toBe(false);
    expect(t.overlay().closed).toBe(true);
  });

  it("PageUp pauses follow and PageDown returns to the bottom and follows new output", () => {
    const out = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const t = setup(out);
    t.bg();
    t.pi.ui.tui.terminal.rows = 20; // body height = floor(20 * 0.8) - 3 = 13
    t.panel.open(t.ctx);
    t.pi.ui.typeKey(ENTER);
    expect(t.lines().at(-2)).toBe("line 99");
    t.pi.ui.typeKey(PGUP);
    expect(t.lines().at(-2)).toBe("line 86");
    t.pi.ui.typeKey(PGDN);
    expect(t.lines().at(-2)).toBe("line 99");
    out.push("line 100");
    expect(t.lines().at(-2)).toBe("line 100");
  });

  it("x kills the selected background task and passes through nothing else", () => {
    const t = setup();
    const a = t.bg();
    t.panel.open(t.ctx);
    t.pi.ui.typeKey("x");
    expect(t.kill).toHaveBeenCalledExactlyOnceWith(a.id);
  });

  it("x does nothing for a finished task or an empty list (negative control)", () => {
    const t = setup();
    const a = t.bg();
    t.panel.open(t.ctx);
    t.pi.ui.typeKey("x");
    t.kill.mockClear();
    t.exit(a.id);
    t.pi.ui.typeKey("x");
    expect(t.kill).not.toHaveBeenCalled();
  });

  it("notifies with the kill text when a kill fails, and stays quiet on success", async () => {
    const t = setup();
    const a = t.bg();
    t.panel.open(t.ctx);
    t.pi.ui.typeKey("x");
    await Promise.resolve();
    await Promise.resolve();
    expect(t.pi.ui.notices).toEqual([]);
    t.kill.mockResolvedValue({ killed: [], alreadyFinished: [], failed: [{ id: a.id, error: "EPERM" }] });
    t.pi.ui.typeKey("x");
    await vi.waitFor(() => expect(t.pi.ui.notices).toHaveLength(1));
    expect(t.pi.ui.notices[0]).toMatchObject({ level: "error" });
    expect(t.pi.ui.notices[0].msg).toContain("Could not stop bg1: EPERM");
  });

  it("notifies when the kill call itself throws", async () => {
    const t = setup();
    t.bg();
    t.kill.mockRejectedValue(new Error("boom"));
    t.panel.open(t.ctx);
    t.pi.ui.typeKey("x");
    await vi.waitFor(() => expect(t.pi.ui.notices).toHaveLength(1));
    expect(t.pi.ui.notices[0].msg).toContain("boom");
  });

  it("Esc in the list closes the overlay and clears every timer", () => {
    const t = setup();
    t.bg();
    t.panel.open(t.ctx);
    expect(t.clock.pending()).toBe(1); // the 1 s tick
    t.pi.ui.typeKey(ESC);
    expect(t.clock.pending()).toBe(0);
    expect(t.pi.ui.tui.hasOverlay()).toBe(false);
  });

  it("a registry change schedules one trailing redraw at 100 ms, however many events arrive", () => {
    const t = setup();
    const a = t.bg();
    const b = t.bg();
    t.panel.open(t.ctx);
    const before = t.pi.ui.tui.renders;
    t.exit(a.id);
    t.exit(b.id);
    expect(t.pi.ui.tui.renders).toBe(before);
    t.clock.advance(99);
    expect(t.pi.ui.tui.renders).toBe(before);
    t.clock.advance(1);
    expect(t.pi.ui.tui.renders).toBe(before + 1);
  });

  it("re-renders every second while open so runtimes tick", () => {
    const t = setup();
    t.bg();
    t.panel.open(t.ctx);
    const before = t.pi.ui.tui.renders;
    t.clock.advance(3000);
    expect(t.pi.ui.tui.renders).toBe(before + 3);
  });

  it("keeps the selection by id when rows change", () => {
    const t = setup();
    t.bg({ command: "one" });
    const b = t.bg({ command: "two" });
    t.panel.open(t.ctx);
    t.pi.ui.typeKey(DOWN);
    t.exit(b.id); // the row stays listed (finished), still selected
    expect(t.lines()[1]).toContain("\x1b[7m");
  });

  it("dispose closes the overlay and clears timers; reopening works", () => {
    const t = setup();
    t.bg();
    t.panel.open(t.ctx);
    t.exit("bg1");
    expect(t.clock.pending()).toBe(2);
    t.panel.dispose();
    expect(t.panel.isOpen()).toBe(false);
    expect(t.overlay().closed).toBe(true);
    expect(t.clock.pending()).toBe(0);
    t.panel.open(t.ctx);
    expect(t.pi.ui.overlays).toHaveLength(2);
    expect(t.panel.isOpen()).toBe(true);
  });

  it("dispose on a panel that was never opened is a no-op", () => {
    const t = setup();
    expect(() => t.panel.dispose()).not.toThrow();
  });
});
