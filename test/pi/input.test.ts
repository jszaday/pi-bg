import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { installMoveKey } from "../../src/pi/input.js";
import type { ShellsPanel } from "../../src/pi/shells-panel.js";
import { w7Ctx, w7Setup, w7Spec } from "./w7-helpers.js";

const CTRL_B = "\x02";
const CTRL_A = "\x01";

function setup(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const { registry, pi } = w7Setup();
  const move = vi.fn(() => ["bg1"]);
  const key = vi.fn(() => "ctrl+b");
  const unsub = installMoveKey(w7Ctx(pi, mode), { registry, key, move });
  return { registry, pi, move, key, unsub };
}

describe("installMoveKey", () => {
  it("passes the key through when nothing is movable", () => {
    const { pi, move } = setup();
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it("consumes the matching key and moves while a foreground task exists", () => {
    const { pi, move, registry } = setup();
    registry.create(w7Spec());
    expect(pi.ui.typeKey(CTRL_B)).toBe(true);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("moves once on a kitty press and ignores the release of the move key", () => {
    const { pi, move, registry } = setup();
    registry.create(w7Spec());
    const press = "\x1b[98;5u";
    const release = "\x1b[98;5:3u";
    expect(isKeyRelease(release)).toBe(true);
    expect(matchesKey(release, "ctrl+b")).toBe(true);
    expect(pi.ui.typeKey(press)).toBe(true);
    expect(pi.ui.typeKey(release)).toBe(false);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("passes the key through when move() moves nothing (negative control for the consume rule)", () => {
    const { pi, move, registry } = setup();
    move.mockReturnValue([]);
    registry.create(w7Spec());
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("passes the key through to the editor when it holds text, and consumes it again once empty (#11)", () => {
    const { pi, move, registry } = setup();
    registry.create(w7Spec());
    pi.ui.editorText = "steer me";
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
    expect(move).not.toHaveBeenCalled();
    pi.ui.editorText = "";
    expect(pi.ui.typeKey(CTRL_B)).toBe(true);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("passes a non-matching key through while movable", () => {
    const { pi, move, registry } = setup();
    registry.create(w7Spec());
    expect(pi.ui.typeKey(CTRL_A)).toBe(false);
    expect(pi.ui.typeKey("x")).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it("passes the key through again once the task is a background task", () => {
    const { pi, move, registry } = setup();
    registry.create(w7Spec({ startInBackground: true }));
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it("reads the configured key on every press", () => {
    const { pi, move, key, registry } = setup();
    registry.create(w7Spec());
    key.mockReturnValue("ctrl+a");
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
    expect(pi.ui.typeKey(CTRL_A)).toBe(true);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe removes the listener", () => {
    const { pi, unsub, registry, move } = setup();
    registry.create(w7Spec());
    expect(pi.ui.listeners).toHaveLength(1);
    unsub();
    expect(pi.ui.listeners).toHaveLength(0);
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
    expect(move).not.toHaveBeenCalled();
  });

  it.each(["rpc", "json", "print"] as const)("installs nothing in %s mode", (mode) => {
    const { pi, unsub } = setup(mode);
    expect(pi.ui.listeners).toHaveLength(0);
    expect(() => unsub()).not.toThrow();
  });

  it("installs nothing in tui mode without UI", () => {
    const { registry, pi } = w7Setup();
    const unsub = installMoveKey(w7Ctx(pi, "tui", false), { registry, key: () => "ctrl+b", move: () => [] });
    expect(pi.ui.listeners).toHaveLength(0);
    unsub();
  });
});

describe("installMoveKey shells focus (#15)", () => {
  const DOWN = "\x1b[B";
  const UP = "\x1b[A";
  const ENTER = "\r";
  const ESC = "\x1b";

  function focusSetup() {
    const { registry, pi } = w7Setup();
    const shells = {
      open: vi.fn(),
      close: vi.fn(),
      dispose: vi.fn(),
      setFooterFocus: vi.fn(),
      opened: false,
      isOpen: () => shells.opened,
    };
    const unsub = installMoveKey(w7Ctx(pi, "tui"), {
      registry,
      key: () => "ctrl+b",
      move: () => [],
      shells: shells as unknown as ShellsPanel,
    });
    const bg = () => registry.create(w7Spec({ startInBackground: true }));
    return { registry, pi, shells, unsub, bg };
  }

  it("Down from an empty editor with a background shell is consumed and focuses the footer", () => {
    const t = focusSetup();
    t.bg();
    expect(t.pi.ui.typeKey(DOWN)).toBe(true);
    expect(t.shells.setFooterFocus).toHaveBeenLastCalledWith(true);
  });

  it("ignores a kitty key release of Down: no focus, no consume", () => {
    const t = focusSetup();
    t.bg();
    const release = "\x1b[1;1:3B";
    expect(isKeyRelease(release)).toBe(true);
    expect(t.pi.ui.typeKey(release)).toBe(false);
    expect(t.shells.setFooterFocus).not.toHaveBeenCalled();
    expect(t.pi.ui.typeKey(DOWN)).toBe(true); // negative control: the press still focuses
  });

  it("captures the TUI through a zero-line widget", () => {
    const t = focusSetup();
    expect(t.pi.ui.widgets).toEqual([{ key: "pi-bg-focus", content: "factory" }]);
    expect(t.pi.ui.widgetComponents.get("pi-bg-focus")!.render(80)).toEqual([]);
  });

  it.each([
    ["the editor holds text", (t: ReturnType<typeof focusSetup>) => void (t.pi.ui.editorText = "hi")],
    ["there are no shells", () => {}],
    ["an overlay is open", (t: ReturnType<typeof focusSetup>) => void t.pi.ui.overlays.push({ closed: false, component: { render: () => [], invalidate() {} } } as never)],
    ["a dialog has focus", (t: ReturnType<typeof focusSetup>) => void (t.pi.ui.focused = { render: () => [] })],
    ["autocomplete is showing", (t: ReturnType<typeof focusSetup>) => void (t.pi.ui.editor.isShowingAutocomplete = () => true)],
    ["nothing is focused", (t: ReturnType<typeof focusSetup>) => void (t.pi.ui.focused = null)],
    ["the panel is open", (t: ReturnType<typeof focusSetup>) => void (t.shells.opened = true)],
  ])("never consumes Down when %s", (name, arrange) => {
    const t = focusSetup();
    if (name !== "there are no shells") t.bg();
    arrange(t);
    expect(t.pi.ui.typeKey(DOWN)).toBe(false);
    expect(t.shells.setFooterFocus).not.toHaveBeenCalled();
  });

  it("never consumes without a TUI handle (negative control: the widget factory was never run)", () => {
    const { registry, pi } = w7Setup();
    pi.ui.setWidget = () => {};
    const shells = { open: vi.fn(), dispose: vi.fn(), setFooterFocus: vi.fn(), isOpen: () => false };
    installMoveKey(w7Ctx(pi, "tui"), { registry, key: () => "ctrl+b", move: () => [], shells: shells as unknown as ShellsPanel });
    registry.create(w7Spec({ startInBackground: true }));
    expect(pi.ui.typeKey(DOWN)).toBe(false);
  });

  it("Enter opens the panel, consumes, and clears focus", () => {
    const t = focusSetup();
    t.bg();
    t.pi.ui.typeKey(DOWN);
    expect(t.pi.ui.typeKey(ENTER)).toBe(true);
    expect(t.shells.open).toHaveBeenCalledTimes(1);
    expect(t.shells.setFooterFocus).toHaveBeenLastCalledWith(false);
  });

  it.each([ESC, UP])("%j clears focus and is consumed without opening", (key) => {
    const t = focusSetup();
    t.bg();
    t.pi.ui.typeKey(DOWN);
    expect(t.pi.ui.typeKey(key)).toBe(true);
    expect(t.shells.open).not.toHaveBeenCalled();
    expect(t.shells.setFooterFocus).toHaveBeenLastCalledWith(false);
  });

  it("other keys clear focus and pass through; unfocused Enter/Esc/Up pass through", () => {
    const t = focusSetup();
    t.bg();
    expect(t.pi.ui.typeKey(ENTER)).toBe(false);
    expect(t.pi.ui.typeKey(ESC)).toBe(false);
    expect(t.pi.ui.typeKey(UP)).toBe(false);
    t.pi.ui.typeKey(DOWN);
    expect(t.pi.ui.typeKey("a")).toBe(false);
    expect(t.shells.setFooterFocus).toHaveBeenLastCalledWith(false);
  });

  it("drops focus without consuming when a dialog takes the keyboard while focused", () => {
    const t = focusSetup();
    t.bg();
    t.pi.ui.typeKey(DOWN);
    t.pi.ui.focused = { render: () => [] };
    expect(t.pi.ui.typeKey(ENTER)).toBe(false);
    expect(t.shells.open).not.toHaveBeenCalled();
    expect(t.shells.setFooterFocus).toHaveBeenLastCalledWith(false);
  });

  it("focus clears when the background count drops to zero", () => {
    const t = focusSetup();
    const a = t.bg();
    t.pi.ui.typeKey(DOWN);
    t.registry.dispatch(a.id, { type: "exit", code: 0, signal: null, at: 0 });
    expect(t.shells.setFooterFocus).toHaveBeenLastCalledWith(false);
  });

  it("without a panel no widget or second listener is installed", () => {
    const { pi } = setup();
    expect(pi.ui.widgets).toEqual([]);
    expect(pi.ui.listeners).toHaveLength(1);
  });

  it("unsubscribe removes both listeners, clears the widget and disposes the panel", () => {
    const t = focusSetup();
    expect(t.pi.ui.listeners).toHaveLength(2);
    t.unsub();
    expect(t.pi.ui.listeners).toHaveLength(0);
    expect(t.pi.ui.widgetComponents.has("pi-bg-focus")).toBe(false);
    expect(t.shells.dispose).toHaveBeenCalledTimes(1);
  });
});
