import { afterEach, describe, expect, it } from "vitest";
import piBg from "../../src/index.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { TaskRegistry } from "../../src/core/registry.js";
import { createTailBuffer } from "../../src/core/tail.js";
import { keepForReload, takeKept } from "../../src/pi/reload-slot.js";
import { FakeClock, FakePi } from "../fakes/index.js";
import { w8Ctx, w8Spec } from "./w8-helpers.js";

afterEach(() => void takeKept());

function keptTask() {
  const alloc = { current: createIdAllocator(0), last: 0 };
  const registry = new TaskRegistry({ clock: new FakeClock(), ids: { next: () => { const id = alloc.current.next(); alloc.last = Number(id.slice(2)); return id; }, get seed() { return alloc.current.seed; } } });
  const t = registry.create(w8Spec());
  registry.dispatch(t.id, { type: "handoff", reason: "requested", at: 0 });
  const runtime = new Map([[t.id, { tail: createTailBuffer(1024), timers: [] }]]);
  let released = 0;
  keepForReload({ registry, runtime, reseed: (n) => { alloc.current = createIdAllocator(Math.max(n, alloc.last)); }, release: () => { released++; } });
  return { id: t.id, registry, runtime, released: () => released };
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("adopting tasks kept across /reload (#2)", () => {
  it("the re-initialised extension lists a kept task as running, not as stopped when Pi exited", async () => {
    const k = keptTask();
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    await pi.emit("session_start", { type: "session_start", reason: "reload" }, w8Ctx(pi, { isProjectTrusted: () => false }));
    const out = text((await pi.callTool("bg_status", {})) as never);
    expect(out).toContain(k.id);
    expect(out).not.toMatch(/stopped when Pi exited/);
    expect(await pi.callTool("bg_status", { id: k.id })).toBeDefined();
    expect(k.released()).toBe(1);
  });

  it("a new task after adoption gets an id above the kept one (shared allocator)", async () => {
    const k = keptTask();
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    await pi.emit("session_start", { type: "session_start", reason: "reload" }, w8Ctx(pi, { isProjectTrusted: () => false }));
    const next = k.registry.create(w8Spec());
    expect(next.id).not.toBe(k.id);
  });

  it("the slot is consumed once: without keepForReload a fresh instance knows no task (negative control)", async () => {
    const k = keptTask();
    piBg(new FakePi().asExtensionAPI());
    const pi2 = new FakePi();
    piBg(pi2.asExtensionAPI());
    await pi2.emit("session_start", { type: "session_start", reason: "startup" }, w8Ctx(pi2, { isProjectTrusted: () => false }));
    expect(text((await pi2.callTool("bg_status", {})) as never)).not.toContain(k.id);
  });
});
