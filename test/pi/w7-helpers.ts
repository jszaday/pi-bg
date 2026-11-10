import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BgConfig, TaskSpec } from "../../src/contract.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { TaskRegistry } from "../../src/core/registry.js";
import { FakeClock, FakePi } from "../fakes/index.js";

export const w7Spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  command: "make",
  cwd: "/tmp",
  hardTimeoutMs: null,
  bgTimeoutMs: 30_000,
  notify: "done",
  startInBackground: false,
  ...over,
});

export const w7Config = (over: Partial<BgConfig> = {}): BgConfig =>
  ({ key: "ctrl+b", hintAfterMs: 2000, ...over }) as BgConfig;

export function w7Setup() {
  const clock = new FakeClock();
  const registry = new TaskRegistry({ clock, ids: createIdAllocator(0) });
  const pi = new FakePi();
  return { clock, registry, pi };
}

/** FakePi context with a mode, cast to the real type. */
export function w7Ctx(pi: FakePi, mode: "tui" | "rpc" | "json" | "print" = "tui", hasUI = mode === "tui" || mode === "rpc") {
  return { ...pi.makeCtx({ hasUI }), mode } as unknown as ExtensionContext;
}
