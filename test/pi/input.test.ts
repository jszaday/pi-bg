import { describe, expect, it, vi } from "vitest";
import { installMoveKey } from "../../src/pi/input.js";
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

  it("passes the key through when move() moves nothing (negative control for the consume rule)", () => {
    const { pi, move, registry } = setup();
    move.mockReturnValue([]);
    registry.create(w7Spec());
    expect(pi.ui.typeKey(CTRL_B)).toBe(false);
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
