// Result renderer of the replacing `bash` tool: Pi's native result block, plus a hint line beneath the Elapsed line while
// the command runs in the foreground (countdown to the automatic handoff, and the key to move it now).
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { inMultiplexer, keyLabel, moveHintText } from "../core/format.js";
import { handoffRemainingMs } from "../core/timeout-policy.js";
import type { Services } from "./runtime.js";

interface ResultState {
  box?: Container;
  native?: Component;
  hint?: Text;
}

/** Hint text for the foreground task of `toolCallId`, or undefined when it is not (or not yet) worth showing. */
export function foregroundHint(s: Services, toolCallId: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const task = s.registry.movable().find((t) => t.spec.toolCallId === toolCallId);
  if (!task) return undefined;
  const now = s.clock.now();
  const cfg = s.config();
  if (now - task.startedAt < cfg.hintAfterMs) return undefined;
  const ms = handoffRemainingMs(task.spec, task.startedAt, now);
  return moveHintText(keyLabel(cfg.key, inMultiplexer(env)), ms === null ? undefined : Math.ceil(ms / 1000));
}

/**
 * `renderResult` wrapper. `native` is the built-in bash definition: its result block (output preview and the
 * "Elapsed" / "Took" line) is kept, and the hint goes beneath it while the result is partial. Native redraws the
 * row once a second while partial, which also ticks the countdown.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bashRenderResult(s: Services, native: { renderResult?: (...a: any[]) => Component }): NonNullable<ToolDefinition["renderResult"]> {
  return (result, options, theme, context) => {
    // Native keeps its own fields in the shared state object (timer bookkeeping), so ours live under one key.
    const shared = context.state as { pibg?: ResultState };
    const state = (shared.pibg ??= {});
    const nativeBlock = native.renderResult?.(result, options, theme, { ...context, lastComponent: state.native });
    state.native = nativeBlock;
    const text = options.isPartial ? foregroundHint(s, context.toolCallId) : undefined;
    state.box ??= new Container();
    state.box.clear();
    if (nativeBlock) state.box.addChild(nativeBlock);
    if (text) {
      state.hint ??= new Text("", 0, 0);
      state.hint.setText(`\n${theme.fg("muted", text)}`);
      state.box.addChild(state.hint);
    }
    return state.box;
  };
}
