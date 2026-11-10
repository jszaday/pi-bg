// Move key (DESIGN section 7): one terminal-input listener, TUI mode only.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import type { TaskId } from "../contract.js";
import type { TaskRegistry } from "../core/registry.js";

export function installMoveKey(
  ctx: ExtensionContext,
  deps: { registry: TaskRegistry; key: () => string; move: () => TaskId[] },
): () => void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return () => {};
  // Executed in tmux (spike S4): the listener runs mid-tool with the editor focused, so no registerShortcut fallback is needed.
  return ctx.ui.onTerminalInput((data) => {
    if (deps.registry.movable().length === 0) return undefined;
    if (!matchesKey(data, deps.key() as KeyId)) return undefined;
    if (ctx.ui.getEditorText() !== "") return undefined; // the user is editing a prompt: leave the key to the editor (cursor-left)
    if (deps.move().length === 0) return undefined; // nothing actually moved: leave the key to the editor
    return { consume: true };
  });
}
