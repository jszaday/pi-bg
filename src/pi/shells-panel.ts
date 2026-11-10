// Shells panel (DESIGN "shells panel", issue #15): a modal overlay over the pure view model in core/shells-view.ts.
// This file only wires keys, truncation, styling and redraw timing to Pi.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Clock, TaskId, TaskSummary, TimerHandle } from "../contract.js";
import { killText, type KillResult } from "../core/format.js";
import type { TaskRegistry } from "../core/registry.js";
import {
  initialView, onOutputGrowth, reconcile, reduce, renderDetail, renderList, shellRows,
  type ShellsKey, type ShellsViewState,
} from "../core/shells-view.js";

const OUTPUT_LINES = 500;
const REDRAW_MS = 100; // trailing throttle for registry-driven redraws
const TICK_MS = 1000; // re-arm while open so runtimes tick
const MIN_BODY = 3;
const PENDING_LOG = "(reading log…)";
const FRAME = 2; // top and bottom border
const CHROME = 6; // detail: FRAME + header (2 lines) + separator + hint

export interface ShellsPanel {
  open(ctx: ExtensionContext): void;
  isOpen(): boolean;
  /** Tells the footer whether its "N shells" item is focused (delegates to the injected setter). */
  setFooterFocus(focused: boolean): void;
  close(): void;
  dispose(): void;
}

export interface ShellsPanelDeps {
  registry: TaskRegistry;
  clock: Clock;
  kill: (id: TaskId) => Promise<KillResult>;
  tailOf: (id: TaskId, n: number) => string[];
  /** Complete output lines the task ever produced (monotonic); lets a paused view count lines that scrolled out of the tail window. */
  totalLinesOf: (id: TaskId) => number;
  /** True once the task's in-memory output ring was released; `tailOf` has nothing for it then. */
  released?: (id: TaskId) => boolean;
  /** Async log read for a released task; the panel calls it at most once per task per open panel. */
  releasedTail?: (id: TaskId, n: number) => Promise<string[]>;
  setFooterFocus: (focused: boolean) => void;
}

const flat = (s: string): string => s.replace(/[\r\n\t]/g, " ");

function toKey(data: string): ShellsKey {
  if (matchesKey(data, "up")) return "up";
  if (matchesKey(data, "down")) return "down";
  if (matchesKey(data, "enter")) return "enter";
  if (matchesKey(data, "escape")) return "escape";
  if (matchesKey(data, "pageUp")) return "pageUp";
  if (matchesKey(data, "pageDown")) return "pageDown";
  if (matchesKey(data, "x")) return "kill";
  return "other";
}

export function createShellsPanel(deps: ShellsPanelDeps): ShellsPanel {
  let active = false; // set at open(), before Pi has run the factory
  let done: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  let pending: { cancelled: boolean } | undefined; // the open() whose factory Pi has not run yet

  const stop = (): void => {
    const c = cleanup;
    cleanup = undefined;
    c?.();
  };

  const panel: ShellsPanel = {
    isOpen: () => active,
    setFooterFocus: (f) => deps.setFooterFocus(f),
    close(): void {
      const d = done;
      stop();
      d?.();
      if (!d && pending) {
        // Closed before Pi ran the factory: the factory will finish at once, and the panel is not open meanwhile.
        pending.cancelled = true;
        pending = undefined;
        active = false;
      }
    },
    dispose(): void {
      panel.close();
    },
    open(ctx: ExtensionContext): void {
      if (active) return;
      active = true;
      let closed = false;
      const request = { cancelled: false };
      pending = request;
      void ctx.ui
        .custom<void>(
          (tui, theme, _kb, finish) => {
            if (pending === request) pending = undefined;
            if (request.cancelled) {
              void Promise.resolve().then(() => finish()); // closed before Pi showed it: dismiss at once
              return { render: () => [], invalidate: () => {} };
            }
            // Released tasks: log tail by id, fetched once (their output no longer changes); a string is the failure line.
            const releasedLines = new Map<TaskId, string[] | string>();
            const tailLines = (id: TaskId, n: number): string[] => {
              const lines = deps.tailOf(id, n);
              if (lines.length > 0 || !deps.releasedTail || !deps.released?.(id)) return lines;
              const got = releasedLines.get(id);
              if (Array.isArray(got)) return got.slice(-n);
              if (typeof got === "string") return [got];
              releasedLines.set(id, PENDING_LOG);
              deps.releasedTail(id, OUTPUT_LINES).then(
                (l) => settle(id, l),
                (e: unknown) =>
                  settle(id, `(could not read the log of ${id}: ${e instanceof Error ? e.message : String(e)}. Action: check output.logDir, or rerun the command.)`),
              );
              return [PENDING_LOG];
            };
            const settle = (id: TaskId, result: string[] | string): void => {
              if (closed) return;
              releasedLines.set(id, result);
              sync();
              redrawSoon();
            };
            const rowsNow = (): TaskSummary[] =>
              shellRows(deps.registry.list().map((t) => deps.registry.summarize(t, tailLines(t.id, 1))));
            let rows = rowsNow();
            let view: ShellsViewState = initialView(rows);
            let redrawTimer: TimerHandle | undefined;
            let tickTimer: TimerHandle | undefined;

            let seen: { id: TaskId; total: number } | undefined; // lines-ever count last accounted for
            const trackGrowth = (): void => {
              const row = view.mode === "detail" ? selected() : undefined;
              if (!row) {
                seen = undefined;
                return;
              }
              const lines = outputOf().length;
              const total = deps.totalLinesOf(row.id);
              // Growth comes from the lines-ever counter: once the tail window is full, the length stops growing while lines still shift.
              // A released task no longer changes, so its counter is constant.
              if (seen && seen.id === row.id) view = onOutputGrowth(view, total - seen.total, lines, bodyHeight());
              seen = { id: row.id, total };
            };
            const sync = (): void => {
              const next = rowsNow();
              view = reconcile(view, next, rows);
              rows = next;
              trackGrowth();
            };
            const redrawSoon = (): void => {
              if (redrawTimer !== undefined) return;
              redrawTimer = deps.clock.setTimeout(() => {
                redrawTimer = undefined;
                tui.requestRender();
              }, REDRAW_MS);
            };
            const tick = (): void => {
              tickTimer = deps.clock.setTimeout(() => {
                sync();
                tui.requestRender();
                tick();
              }, TICK_MS);
            };
            const unsubscribe = deps.registry.subscribe(() => {
              sync();
              redrawSoon();
            });
            tick();

            const finishOnce = (): void => {
              if (closed) return;
              closed = true;
              active = false;
              done = undefined;
              cleanup = undefined;
              unsubscribe();
              if (redrawTimer !== undefined) deps.clock.clearTimeout(redrawTimer);
              if (tickTimer !== undefined) deps.clock.clearTimeout(tickTimer);
              redrawTimer = tickTimer = undefined;
            };
            cleanup = finishOnce;
            done = () => finish();

            const maxRows = (): number => Math.max(CHROME + MIN_BODY, Math.floor((tui.terminal.rows ?? 24) * 0.8));
            const bodyHeight = (): number => Math.max(MIN_BODY, maxRows() - CHROME);
            const selected = (): TaskSummary | undefined => rows.find((r) => r.id === view.selectedId);
            const outputOf = (): string[] => {
              const row = selected();
              return row ? tailLines(row.id, OUTPUT_LINES) : [];
            };

            return {
              render(width: number): string[] {
                // Rounded box: border colour, accent marker, selectedBg row, dim hint.
                const innerW = Math.max(1, width - 2);
                const bar = (l: string, r: string): string => theme.fg("border", l + "─".repeat(innerW) + r);
                const frame = (content: string[]): string[] => [bar("╭", "╮"), ...content, bar("╰", "╯")];
                const sep = bar("├", "┤");
                const boxed = (s: string): string =>
                  theme.fg("border", "│") + s + " ".repeat(Math.max(0, innerW - visibleWidth(s))) + theme.fg("border", "│");
                const cut = (s: string, room: number): string => truncateToWidth(flat(s), Math.max(1, room), "...");
                const plain = (s: string): string => boxed(" " + cut(s, innerW - 1));
                const dim = (s: string): string => boxed(" " + theme.fg("dim", cut(s, innerW - 1)));
                const row = selected();
                if (view.mode === "detail" && row) {
                  const d = renderDetail(view, row, outputOf(), bodyHeight());
                  return frame([plain(d[0]), plain(d[1]), sep, ...d.slice(2, -1).map(plain), dim(d[d.length - 1])]);
                }
                const { lines, selected: sel } = renderList(view, rows);
                if (rows.length === 0) return frame(lines.map((l) => boxed(" " + theme.fg("muted", cut(l, innerW - 1)))));
                // Window the rows around the selection so it stays visible; the last line is the hint.
                const hint = lines.length - 1;
                const body = lines.slice(0, hint);
                const room = Math.max(MIN_BODY, maxRows() - FRAME - 1);
                const start = sel === undefined ? 0 : Math.max(0, Math.min(sel - room + 1, body.length - room));
                const shown = body.slice(start, start + room).map((l, i) =>
                  start + i === sel
                    ? boxed(" " + theme.fg("accent", "❯ ") + theme.bg("selectedBg", theme.fg("text", cut(l, innerW - 3))))
                    : boxed("   " + theme.fg("text", cut(l, innerW - 3))),
                );
                return frame([...shown, dim(lines[hint])]);
              },
              invalidate(): void {},
              handleInput(data: string): void {
                trackGrowth(); // bring the scroll up to date before the key moves it
                const { state, action } = reduce(view, toKey(data), rows, {
                  outputLines: view.mode === "detail" ? outputOf().length : 0,
                  height: bodyHeight(),
                });
                view = state;
                trackGrowth(); // baseline after entering detail or leaving it
                if (action.type === "close") panel.close();
                else if (action.type === "kill") {
                  const report = (msg: string): void => ctx.ui.notify(msg, "error");
                  deps
                    .kill(action.id)
                    .then((r) => {
                      if (r.failed.length > 0) report(killText(r));
                    })
                    .catch((e: unknown) =>
                      report(
                        `Could not kill ${action.id}: ${e instanceof Error ? e.message : String(e)}. Action: retry, or kill its pid manually.`,
                      ),
                    )
                    .finally(() => {
                      if (!closed) redrawSoon();
                    });
                }
              },
              dispose: finishOnce,
            };
          },
          { overlay: true, overlayOptions: { width: "80%", minWidth: 40, maxHeight: "80%", anchor: "center" } },
        )
        .then(
          () => {
            stop();
            if (pending === request) pending = undefined;
          },
          (e: unknown) => {
            stop();
            if (pending === request) pending = undefined;
            active = false;
            ctx.ui.notify(`Could not open the shells panel: ${e instanceof Error ? e.message : String(e)}. Action: use /bg list instead.`, "error");
          },
        );
    },
  };
  return panel;
}
