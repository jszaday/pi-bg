// Move key (DESIGN section 7): one terminal-input listener, TUI mode only.
// Shells panel focus (DESIGN "shells panel", #15): a second listener, installed only when a panel is given.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { TaskId } from "../contract.js";
import type { TaskRegistry } from "../core/registry.js";
import { footerStep, type FooterKey } from "../core/shells-view.js";
import type { ShellsPanel } from "./shells-panel.js";

const FOCUS_WIDGET = "pi-bg-focus";

/** The two TUI members the focus gate reads, captured from a widget factory argument. */
interface TuiHandle {
  hasOverlay(): boolean;
  getFocusedComponent(): unknown;
}

function footerKey(data: string): FooterKey {
  if (matchesKey(data, "down")) return "down";
  if (matchesKey(data, "up")) return "up";
  if (matchesKey(data, "enter")) return "enter";
  if (matchesKey(data, "escape")) return "escape";
  return "other";
}

/** True only when the editor itself has focus with no autocomplete menu; unknown focus means false (fail closed). */
function editorHasFocus(tui: TuiHandle | undefined): boolean {
  if (!tui || tui.hasOverlay()) return false;
  // TODO(#15): duck-typed editor focus check relies on Pi internals (isShowingAutocomplete); replace when Pi exposes a dialog/overlay flag
  const c = tui.getFocusedComponent() as { isShowingAutocomplete?: unknown } | null | undefined;
  if (!c || typeof c.isShowingAutocomplete !== "function") return false;
  return (c as { isShowingAutocomplete(): boolean }).isShowingAutocomplete() === false;
}

export function installMoveKey(
  ctx: ExtensionContext,
  deps: { registry: TaskRegistry; key: () => string; move: () => TaskId[]; shells?: ShellsPanel },
): () => void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return () => {};
  // Executed in tmux (spike S4): the listener runs mid-tool with the editor focused, so no registerShortcut fallback is needed.
  const unsubscribeMove = ctx.ui.onTerminalInput((data) => {
    if (isKeyRelease(data)) return undefined; // Pi hands listeners kitty releases too; only the press moves
    if (deps.registry.movable().length === 0) return undefined;
    if (!matchesKey(data, deps.key() as KeyId)) return undefined;
    if (ctx.ui.getEditorText() !== "") return undefined; // the user is editing a prompt: leave the key to the editor (cursor-left)
    if (deps.move().length === 0) return undefined; // nothing actually moved: leave the key to the editor
    return { consume: true };
  });
  const shells = deps.shells;
  if (!shells) return unsubscribeMove;

  let tui: TuiHandle | undefined;
  // A zero-line widget: Pi's above-editor container shows one spacer line with or without a widget, so this adds nothing visible.
  ctx.ui.setWidget(FOCUS_WIDGET, (t) => {
    tui = t as unknown as TuiHandle;
    return { render: () => [], invalidate: () => {} };
  });

  let focused = false;
  const setFocused = (f: boolean): void => {
    if (f === focused) return;
    focused = f;
    shells.setFooterFocus(f);
  };
  const backgroundCount = (): number => deps.registry.running().filter((t) => t.state === "background").length;
  const unsubscribeRegistry = deps.registry.subscribe(() => {
    if (focused && backgroundCount() === 0) setFocused(false);
  });

  const unsubscribeFocus = ctx.ui.onTerminalInput((data) => {
    if (isKeyRelease(data)) return undefined; // Pi hands listeners kitty releases too; only presses move focus
    const key = footerKey(data);
    const count = backgroundCount();
    // Focus starts only on Down and every focused key needs the editor to own the keyboard.
    if (!focused && key !== "down") return undefined;
    if (!editorHasFocus(tui)) {
      setFocused(false); // a dialog, overlay or menu took the keyboard: drop focus, never consume
      return undefined;
    }
    const step = footerStep(focused, key, {
      editorEmpty: ctx.ui.getEditorText() === "",
      shells: count,
      panelOpen: shells.isOpen(),
    });
    setFocused(step.focused);
    if (step.open) shells.open(ctx);
    return step.consume ? { consume: true } : undefined;
  });

  return () => {
    unsubscribeMove();
    unsubscribeFocus();
    unsubscribeRegistry();
    setFocused(false);
    ctx.ui.setWidget(FOCUS_WIDGET, undefined);
    shells.dispose();
  };
}
