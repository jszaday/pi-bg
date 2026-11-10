import { describe, expect, it } from "vitest";
import type { TaskState, TaskSummary } from "../../src/contract.js";
import {
  type FooterKey,
  type ShellsViewState,
  footerLabel,
  footerStep,
  initialView,
  onOutputGrowth,
  reconcile,
  reduce,
  renderDetail,
  renderList,
  shellRows,
} from "../../src/core/shells-view.js";

function row(id: string, state: TaskState = "background", extra: Partial<TaskSummary> = {}): TaskSummary {
  return { id, command: `cmd ${id}`, state, startedAt: "2026-01-01T00:00:00Z", runtimeS: 5, totalBytes: 0, notify: "done", notified: false, logDegraded: false, ...extra };
}
const rows = [row("bg1"), row("bg2"), row("bg3"), row("bg4"), row("bg5")];
const list = (selectedId?: string): ShellsViewState => ({ mode: "list", selectedId, follow: true, scroll: 0 });
const detail = (over: Partial<ShellsViewState> = {}): ShellsViewState => ({ mode: "detail", selectedId: "bg2", follow: true, scroll: 0, ...over });
const view = { outputLines: 50, height: 10 };

describe("shellRows / initialView", () => {
  it("drops foreground tasks and keeps order", () => {
    const all = [row("bg1"), row("bg2", "foreground"), row("bg3", "exited"), row("bg4", "killed")];
    expect(shellRows(all).map((r) => r.id)).toEqual(["bg1", "bg3", "bg4"]);
  });
  it("selects the first row, or nothing when empty", () => {
    expect(initialView(rows)).toEqual({ mode: "list", selectedId: "bg1", follow: true, scroll: 0 });
    expect(initialView([]).selectedId).toBeUndefined();
  });
});

describe("reconcile", () => {
  it("keeps a selection that still exists", () => {
    const s = detail({ follow: false, scroll: 4 });
    expect(reconcile(s, rows)).toBe(s);
  });
  it("selects the row now at the same index when a middle row vanished", () => {
    const next = rows.filter((r) => r.id !== "bg3");
    expect(reconcile(list("bg3"), next, rows).selectedId).toBe("bg4");
  });
  it("clamps to the last row when the last row vanished", () => {
    const next = rows.slice(0, 4);
    expect(reconcile(list("bg5"), next, rows).selectedId).toBe("bg4");
  });
  it("selects nothing when no rows remain", () => {
    expect(reconcile(list("bg1"), [], rows).selectedId).toBeUndefined();
  });
  it("falls back to the first row without prev", () => {
    expect(reconcile(list("gone"), rows).selectedId).toBe("bg1");
  });
  it("falls back from detail to list when the id vanished", () => {
    const next = rows.filter((r) => r.id !== "bg2");
    const out = reconcile(detail({ follow: false, scroll: 3 }), next, rows);
    expect(out).toEqual({ mode: "list", selectedId: "bg3", follow: true, scroll: 0 });
  });
});

describe("reduce, list mode", () => {
  it("moves with up/down, clamped without wrap", () => {
    expect(reduce(list("bg2"), "down", rows, view).state.selectedId).toBe("bg3");
    expect(reduce(list("bg2"), "up", rows, view).state.selectedId).toBe("bg1");
    expect(reduce(list("bg1"), "up", rows, view).state.selectedId).toBe("bg1");
    expect(reduce(list("bg5"), "down", rows, view).state.selectedId).toBe("bg5");
  });
  it("pages by height rows, clamped", () => {
    const v = { outputLines: 0, height: 2 };
    expect(reduce(list("bg1"), "pageDown", rows, v).state.selectedId).toBe("bg3");
    expect(reduce(list("bg4"), "pageDown", rows, v).state.selectedId).toBe("bg5");
    expect(reduce(list("bg3"), "pageUp", rows, v).state.selectedId).toBe("bg1");
    expect(reduce(list("bg1"), "pageUp", rows, v).state.selectedId).toBe("bg1");
  });
  it("does nothing on an empty list", () => {
    for (const k of ["up", "down", "pageUp", "pageDown", "enter", "kill", "other"] as const) {
      const out = reduce(list(undefined), k, [], view);
      expect(out).toEqual({ state: list(undefined), action: { type: "none" } });
    }
  });
  it("enter opens detail following, scroll 0", () => {
    const out = reduce({ ...list("bg2"), follow: false, scroll: 9 }, "enter", rows, view);
    expect(out.state).toEqual({ mode: "detail", selectedId: "bg2", follow: true, scroll: 0 });
    expect(out.action).toEqual({ type: "none" });
  });
  it("escape closes", () => {
    expect(reduce(list("bg2"), "escape", rows, view).action).toEqual({ type: "close" });
  });
  it("kills only a background row", () => {
    const mixed = [row("bg1"), row("bg2", "exited")];
    expect(reduce(list("bg1"), "kill", mixed, view).action).toEqual({ type: "kill", id: "bg1" });
    expect(reduce(list("bg2"), "kill", mixed, view).action).toEqual({ type: "none" });
  });
  it("ignores other keys", () => {
    const s = list("bg2");
    expect(reduce(s, "other", rows, view)).toEqual({ state: s, action: { type: "none" } });
  });
});

describe("reduce, detail mode", () => {
  it("pageUp stops following and scrolls by height, clamped to the maximum", () => {
    const a = reduce(detail(), "pageUp", rows, view).state;
    expect(a).toMatchObject({ follow: false, scroll: 10 });
    const b = reduce(detail({ follow: false, scroll: 35 }), "pageUp", rows, view).state;
    expect(b.scroll).toBe(40);
  });
  it("pageUp with nothing to scroll keeps following", () => {
    expect(reduce(detail(), "pageUp", rows, { outputLines: 4, height: 10 }).state).toMatchObject({ follow: true, scroll: 0 });
  });
  it("pageDown scrolls toward the bottom and resumes following at 0", () => {
    const a = reduce(detail({ follow: false, scroll: 25 }), "pageDown", rows, view).state;
    expect(a).toMatchObject({ follow: false, scroll: 15 });
    const b = reduce(detail({ follow: false, scroll: 7 }), "pageDown", rows, view).state;
    expect(b).toMatchObject({ follow: true, scroll: 0 });
  });
  it("up/down scroll one line with the same rules", () => {
    const up = reduce(detail(), "up", rows, view).state;
    expect(up).toMatchObject({ follow: false, scroll: 1 });
    expect(reduce(up, "down", rows, view).state).toMatchObject({ follow: true, scroll: 0 });
    expect(reduce(detail({ follow: false, scroll: 40 }), "up", rows, view).state.scroll).toBe(40);
    expect(reduce(detail(), "down", rows, view).state).toMatchObject({ follow: true, scroll: 0 });
  });
  it("escape returns to the list keeping the selection", () => {
    const out = reduce(detail({ follow: false, scroll: 5 }), "escape", rows, view);
    expect(out.state).toEqual({ mode: "list", selectedId: "bg2", follow: true, scroll: 0 });
    expect(out.action).toEqual({ type: "none" });
  });
  it("kill follows the list rule and enter does nothing", () => {
    expect(reduce(detail(), "kill", rows, view).action).toEqual({ type: "kill", id: "bg2" });
    const ended = [row("bg2", "killed")];
    expect(reduce(detail(), "kill", ended, view).action).toEqual({ type: "none" });
    const s = detail();
    expect(reduce(s, "enter", rows, view)).toEqual({ state: s, action: { type: "none" } });
  });
});

describe("onOutputGrowth", () => {
  it("a paused detail view moves up by the added lines to keep the same lines", () => {
    expect(onOutputGrowth(detail({ follow: false, scroll: 5 }), 3, 53, 10)).toMatchObject({ follow: false, scroll: 8 });
  });
  it("clamps to the maximum scroll", () => {
    expect(onOutputGrowth(detail({ follow: false, scroll: 40 }), 3, 50, 10).scroll).toBe(40);
  });
  it("moves up by lines added even when the output length did not change (full tail window)", () => {
    expect(onOutputGrowth(detail({ follow: false, scroll: 5 }), 2, 500, 10).scroll).toBe(7);
  });
  it("leaves a following detail view unchanged", () => {
    const s = detail();
    expect(onOutputGrowth(s, 3, 53, 10)).toBe(s);
  });
  it("leaves list mode unchanged", () => {
    const s: ShellsViewState = { ...list("bg1"), follow: false, scroll: 5 };
    expect(onOutputGrowth(s, 3, 53, 10)).toBe(s);
  });
  it("ignores no growth and shrinkage", () => {
    const s = detail({ follow: false, scroll: 5 });
    expect(onOutputGrowth(s, 0, 50, 10)).toBe(s);
    expect(onOutputGrowth(s, -2, 48, 10)).toBe(s);
  });
});

describe("footerStep", () => {
  const ok = { editorEmpty: true, shells: 2, panelOpen: false };
  const keys: FooterKey[] = ["down", "up", "enter", "escape", "other"];
  const unchanged = { focused: false, consume: false, open: false };

  it("not focused: only down with an empty editor, shells and no panel takes focus", () => {
    expect(footerStep(false, "down", ok)).toEqual({ focused: true, consume: true, open: false });
    for (const k of keys.filter((k) => k !== "down")) expect(footerStep(false, k, ok)).toEqual(unchanged);
    expect(footerStep(false, "down", { ...ok, editorEmpty: false })).toEqual(unchanged);
    expect(footerStep(false, "down", { ...ok, shells: 0 })).toEqual(unchanged);
    expect(footerStep(false, "down", { ...ok, panelOpen: true })).toEqual(unchanged);
  });
  it("focused: enter opens, escape and up unfocus, down stays, other passes through", () => {
    expect(footerStep(true, "enter", ok)).toEqual({ focused: false, consume: true, open: true });
    expect(footerStep(true, "escape", ok)).toEqual({ focused: false, consume: true, open: false });
    expect(footerStep(true, "up", ok)).toEqual({ focused: false, consume: true, open: false });
    expect(footerStep(true, "down", ok)).toEqual({ focused: true, consume: true, open: false });
    expect(footerStep(true, "other", ok)).toEqual(unchanged);
  });
  it("focused with no shells or an open panel drops focus for every key", () => {
    for (const k of keys) {
      expect(footerStep(true, k, { ...ok, shells: 0 })).toEqual(unchanged);
      expect(footerStep(true, k, { ...ok, panelOpen: true })).toEqual(unchanged);
    }
  });
});

describe("footerLabel", () => {
  it("wraps in reverse video only when focused", () => {
    expect(footerLabel("2 shells", true)).toBe("\x1b[7m2 shells\x1b[27m");
    expect(footerLabel("2 shells", false)).toBe("2 shells");
  });
});

describe("renderList", () => {
  it("renders one line for an empty list", () => {
    expect(renderList(list(undefined), [])).toEqual({ lines: ["No background shells."], selected: undefined });
  });
  it("renders rows, the selected index and a hint", () => {
    const out = renderList(list("bg2"), rows.slice(0, 3));
    expect(out.lines).toHaveLength(4);
    expect(out.selected).toBe(1);
    expect(out.lines[3]).toContain("esc close");
  });
  it("shows id, state, runtime, command and the last output line", () => {
    const r = row("bg7", "background", { runtimeS: 125, lastLines: ["a", "last one"] });
    expect(renderList(list("bg7"), [r]).lines[0]).toBe("bg7  background  2m 05s  cmd bg7  last one");
  });
  it("omits the output part when there is no output", () => {
    expect(renderList(list("bg1"), [row("bg1", "exited")]).lines[0]).toBe("bg1  exited  5s  cmd bg1");
  });
  it("selects nothing when the id is unknown", () => {
    expect(renderList(list("zzz"), rows).selected).toBeUndefined();
  });
});

describe("renderDetail", () => {
  const out = Array.from({ length: 20 }, (_, i) => `l${i}`);
  const r = row("bg2");
  const body = (lines: string[]) => lines.slice(2, -1);
  it("has a header, the command and a hint", () => {
    const lines = renderDetail(detail(), r, out, 3);
    expect(lines[0]).toBe("bg2  background  5s");
    expect(lines[1]).toBe("cmd bg2");
    expect(lines[lines.length - 1]).toContain("esc back");
  });
  it("follows the bottom", () => {
    expect(body(renderDetail(detail(), r, out, 3))).toEqual(["l17", "l18", "l19"]);
  });
  it("shows the window scrolled above the bottom", () => {
    expect(body(renderDetail(detail({ follow: false, scroll: 5 }), r, out, 3))).toEqual(["l12", "l13", "l14"]);
  });
  it("clamps an oversized scroll to the top", () => {
    expect(body(renderDetail(detail({ follow: false, scroll: 99 }), r, out, 3))).toEqual(["l0", "l1", "l2"]);
  });
  it("shows all lines when fewer than the height, and none at height 0", () => {
    expect(body(renderDetail(detail(), r, ["a", "b"], 5))).toEqual(["a", "b"]);
    expect(body(renderDetail(detail(), r, out, 0))).toEqual([]);
  });
});
