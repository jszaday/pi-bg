// Footer status (DESIGN section 14): "k shells" while background tasks run. Pure presentation over the registry; shown in tui and rpc.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UiSink } from "../contract.js";
import { footerText } from "../core/format.js";
import type { TaskRegistry } from "../core/registry.js";

export const UI_KEY = "pi-bg";

/** Shows `msg` to the user: ctx.ui.notify in tui and rpc, stderr in print and json. */
export function notifyUser(ctx: ExtensionContext | undefined, msg: string, level: "info" | "warning" | "error"): void {
  if (ctx && (ctx.mode === "tui" || ctx.mode === "rpc")) ctx.ui.notify(msg, level);
  else process.stderr.write(`pi-bg: ${msg}\n`);
}

export function createUi(
  _pi: ExtensionAPI,
  deps: { registry: TaskRegistry },
): UiSink & { onSessionStart(ctx: ExtensionContext): void; dispose(): void } {
  let ctx: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let shown: string | undefined;

  const ui = {
    refresh(): void {
      if (!ctx || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return;
      const status = footerText(deps.registry.running().filter((t) => t.state === "background").length);
      if (status === shown) return;
      ctx.ui.setStatus(UI_KEY, status);
      shown = status;
    },
    notify(msg: string, level: "info" | "warning" | "error"): void {
      notifyUser(ctx, msg, level);
    },
    onSessionStart(c: ExtensionContext): void {
      ui.dispose();
      ctx = c;
      unsubscribe = deps.registry.subscribe(() => ui.refresh());
      ui.refresh();
    },
    dispose(): void {
      unsubscribe?.();
      unsubscribe = undefined;
      if (ctx && (ctx.mode === "tui" || ctx.mode === "rpc") && shown !== undefined) ctx.ui.setStatus(UI_KEY, undefined);
      shown = undefined;
      ctx = undefined;
    },
  };
  return ui;
}
