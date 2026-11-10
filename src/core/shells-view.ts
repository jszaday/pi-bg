// Pure view model for the shells panel (DESIGN "shells panel", issue #15): selection, scrolling,
// key handling and plain-text rendering. No Pi, no node:*; the Pi layer truncates, styles and wires keys.
import type { TaskId, TaskSummary } from "../contract.js";

export type ShellsKey = "up" | "down" | "enter" | "escape" | "pageUp" | "pageDown" | "kill" | "other";
export interface ShellsViewState {
  mode: "list" | "detail";
  selectedId?: TaskId;
  follow: boolean;
  /** Detail mode: lines above the bottom when not following. */
  scroll: number;
}
export type ShellsAction = { type: "none" } | { type: "close" } | { type: "kill"; id: TaskId };
export type FooterKey = "down" | "up" | "enter" | "escape" | "other";

const NO_SHELLS = "No background shells.";
const LIST_HINT = "↑↓ select · enter view · x kill · esc close";
const DETAIL_HINT = "pgup/pgdn scroll · x kill · esc back";

// TODO(#15): use format.ts formatRuntime once it is exported (owned by another stream)
function formatRuntime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Every task except a foreground one, input order kept. */
export function shellRows(all: TaskSummary[]): TaskSummary[] {
  return all.filter((t) => t.state !== "foreground");
}

export function initialView(rows: TaskSummary[]): ShellsViewState {
  return { mode: "list", selectedId: rows[0]?.id, follow: true, scroll: 0 };
}

/**
 * Re-anchors the state on a fresh row list. The selection is kept by id. When it vanished, the row now at
 * the old index (clamped) is selected; the old index needs `prev`, the rows the state was last reconciled
 * against, and without it the first row is selected. Detail mode on a vanished id falls back to list.
 */
export function reconcile(s: ShellsViewState, rows: TaskSummary[], prev?: TaskSummary[]): ShellsViewState {
  if (s.selectedId !== undefined && rows.some((r) => r.id === s.selectedId)) return s;
  const oldIndex = prev && s.selectedId !== undefined ? prev.findIndex((r) => r.id === s.selectedId) : -1;
  const next = rows.length === 0 ? undefined : rows[clamp(oldIndex < 0 ? 0 : oldIndex, 0, rows.length - 1)].id;
  return { mode: "list", selectedId: next, follow: true, scroll: 0 };
}

function selectedIndex(s: ShellsViewState, rows: TaskSummary[]): number {
  return s.selectedId === undefined ? -1 : rows.findIndex((r) => r.id === s.selectedId);
}

function scrollBy(s: ShellsViewState, delta: number, outputLines: number, height: number): ShellsViewState {
  const max = Math.max(0, outputLines - height);
  const scroll = clamp((s.follow ? 0 : s.scroll) + delta, 0, max);
  // At the bottom the view follows again; following with nothing to scroll is the same view.
  return { ...s, scroll, follow: scroll === 0 };
}

export function reduce(
  s: ShellsViewState,
  key: ShellsKey,
  rows: TaskSummary[],
  view: { outputLines: number; height: number },
): { state: ShellsViewState; action: ShellsAction } {
  const none: ShellsAction = { type: "none" };
  const idx = selectedIndex(s, rows);
  if (key === "kill") {
    const row = idx < 0 ? undefined : rows[idx];
    return { state: s, action: row && row.state === "background" ? { type: "kill", id: row.id } : none };
  }
  if (s.mode === "list") {
    const move = (delta: number) => {
      if (rows.length === 0) return { state: s, action: none };
      const to = clamp((idx < 0 ? 0 : idx) + delta, 0, rows.length - 1);
      return { state: { ...s, selectedId: rows[to].id }, action: none };
    };
    switch (key) {
      case "up":
        return move(-1);
      case "down":
        return move(1);
      case "pageUp":
        return move(-Math.max(1, view.height));
      case "pageDown":
        return move(Math.max(1, view.height));
      case "enter":
        return idx < 0 ? { state: s, action: none } : { state: { ...s, mode: "detail", follow: true, scroll: 0 }, action: none };
      case "escape":
        return { state: s, action: { type: "close" } };
      default:
        return { state: s, action: none };
    }
  }
  switch (key) {
    case "up":
      return { state: scrollBy(s, 1, view.outputLines, view.height), action: none };
    case "down":
      return { state: scrollBy(s, -1, view.outputLines, view.height), action: none };
    case "pageUp":
      return { state: scrollBy(s, view.height, view.outputLines, view.height), action: none };
    case "pageDown":
      return { state: scrollBy(s, -view.height, view.outputLines, view.height), action: none };
    case "escape":
      return { state: { ...s, mode: "list", follow: true, scroll: 0 }, action: none };
    default:
      return { state: s, action: none };
  }
}

function rowText(t: TaskSummary): string {
  const last = t.lastLines && t.lastLines.length > 0 ? t.lastLines[t.lastLines.length - 1] : undefined;
  const parts = [t.id, t.state, formatRuntime(t.runtimeS), t.command];
  if (last !== undefined) parts.push(last);
  return parts.join("  ");
}

export function renderList(s: ShellsViewState, rows: TaskSummary[]): { lines: string[]; selected?: number } {
  if (rows.length === 0) return { lines: [NO_SHELLS], selected: undefined };
  const idx = selectedIndex(s, rows);
  return { lines: [...rows.map(rowText), LIST_HINT], selected: idx < 0 ? undefined : idx };
}

export function renderDetail(s: ShellsViewState, row: TaskSummary, output: string[], height: number): string[] {
  const h = Math.max(0, height);
  const max = Math.max(0, output.length - h);
  const above = s.follow ? 0 : clamp(s.scroll, 0, max);
  const end = output.length - above;
  const window = output.slice(Math.max(0, end - h), end);
  return [`${row.id}  ${row.state}  ${formatRuntime(row.runtimeS)}`, row.command, ...window, DETAIL_HINT];
}

/** Focus of the footer "N shells" item: Down from an empty editor focuses it, Enter opens the panel. */
export function footerStep(
  focused: boolean,
  key: FooterKey,
  ctx: { editorEmpty: boolean; shells: number; panelOpen: boolean },
): { focused: boolean; consume: boolean; open: boolean } {
  if (!focused) {
    const take = key === "down" && ctx.editorEmpty && ctx.shells > 0 && !ctx.panelOpen;
    return { focused: take, consume: take, open: false };
  }
  if (ctx.shells === 0 || ctx.panelOpen) return { focused: false, consume: false, open: false };
  switch (key) {
    case "enter":
      return { focused: false, consume: true, open: true };
    case "escape":
    case "up":
      return { focused: false, consume: true, open: false };
    case "down":
      return { focused: true, consume: true, open: false };
    default:
      return { focused: false, consume: false, open: false };
  }
}

export function footerLabel(text: string, focused: boolean): string {
  return focused ? `\x1b[7m${text}\x1b[27m` : text;
}
