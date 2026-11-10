import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { bashRenderResult, foregroundHint } from "../../src/pi/bash-render.js";
import { w7Config, w7Setup, w7Spec } from "./w7-helpers.js";

function setup(over: Parameters<typeof w7Spec>[0] = {}) {
  const s = w7Setup();
  const task = s.registry.create(w7Spec({ toolCallId: "tc1", ...over }));
  const services = { registry: s.registry, clock: s.clock, config: () => w7Config() } as never;
  return { ...s, task, services };
}

describe("foregroundHint", () => {
  it("is absent before hintAfterMs, then counts down to the handoff", () => {
    const t = setup();
    expect(foregroundHint(t.services, "tc1", {})).toBeUndefined();
    t.clock.advance(2000);
    expect(foregroundHint(t.services, "tc1", {})).toBe("moves to background in 28s (ctrl+b to background now)");
    t.clock.advance(1000);
    expect(foregroundHint(t.services, "tc1", {})).toBe("moves to background in 27s (ctrl+b to background now)");
  });
  it("omits the countdown when no handoff is planned", () => {
    const t = setup({ bgTimeoutMs: null });
    t.clock.advance(2000);
    expect(foregroundHint(t.services, "tc1", {})).toBe("ctrl+b to background now");
  });
  it("shows ctrl+b twice under tmux or herdr", () => {
    const t = setup({ bgTimeoutMs: null });
    t.clock.advance(2000);
    expect(foregroundHint(t.services, "tc1", { TMUX: "x" })).toBe("ctrl+b ctrl+b to background now");
    expect(foregroundHint(t.services, "tc1", { HERDR_ENV: "1" })).toBe("ctrl+b ctrl+b to background now");
  });
  it("is absent for other calls and for background tasks", () => {
    const t = setup();
    t.clock.advance(2000);
    expect(foregroundHint(t.services, "other", {})).toBeUndefined();
    t.registry.dispatch(t.task.id, { type: "handoff", reason: "user", at: t.clock.now() });
    expect(foregroundHint(t.services, "tc1", {})).toBeUndefined();
  });
});

describe("bashRenderResult", () => {
  const theme = { fg: (_c: string, x: string) => x } as never;
  const native = { renderResult: (_r: unknown, _o: unknown, _t: unknown, c: { lastComponent?: Text }) => (c.lastComponent ?? new Text("Elapsed 3s", 0, 0)) };
  const ctx = (state: object) => ({ state, toolCallId: "tc1" }) as never;
  const result = { content: [], details: undefined } as never;

  it("puts the hint under the Elapsed line while partial and drops it when final", () => {
    const t = setup();
    t.clock.advance(2000);
    const render = bashRenderResult(t.services, native);
    const state = {};
    const partial = render(result, { isPartial: true, expanded: false }, theme, ctx(state)).render(80).join("\n");
    expect(partial).toContain("Elapsed 3s");
    expect(partial.indexOf("moves to background in 28s")).toBeGreaterThan(partial.indexOf("Elapsed"));
    const done = render(result, { isPartial: false, expanded: false }, theme, ctx(state)).render(80).join("\n");
    expect(done).toContain("Elapsed 3s");
    expect(done).not.toContain("background");
  });
});
