// Hand-over of running tasks across /reload (DESIGN section 12, #2). Pi re-evaluates the extension module in the same
// process on /reload (jiti with moduleCache off, one JS realm), so a `Symbol.for` key on globalThis reaches the new instance.
import type { TaskId } from "../contract.js";
import type { TaskRegistry } from "../core/registry.js";
import type { TaskRuntime } from "./runtime.js";

/** Runtime state the next instance adopts. */
export interface KeptState {
  registry: TaskRegistry;
  runtime: Map<TaskId, TaskRuntime>;
  /** The id allocator reseed of the instance that owns `registry`, so ids stay unique. */
  reseed(seed: number): void;
  /** Removes the previous instance's exit backstop once the next one has installed its own. */
  release(): void;
}

const KEY = Symbol.for("pi-bg.kept-on-reload");
const slots = globalThis as unknown as Record<symbol, KeptState | undefined>;

export function keepForReload(state: KeptState): void {
  slots[KEY] = state;
}

/** Consumes the slot: at most one instance adopts the kept state. */
export function takeKept(): KeptState | undefined {
  const state = slots[KEY];
  slots[KEY] = undefined;
  return state;
}
