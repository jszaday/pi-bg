import { describe, expect, it } from "vitest";
import type { BgConfig, Task, TaskEvent } from "../../src/contract.js";
import { MONITOR_BATCH_MS, MONITOR_LINE_MAX_CHARS, MONITOR_MAX_LINES, MonitorPolicy } from "../../src/core/monitor-policy.js";
import { FakeClock, FakeMonitorSink } from "../fakes/index.js";

const CONFIG: BgConfig["notify"] = { default: "done", delivery: "steer", wake: true, batchMs: 500 };
const enc = new TextEncoder();
const out = (s: string) => enc.encode(s);

function setup(cfg: Partial<BgConfig["notify"]> = {}) {
  const clock = new FakeClock();
  const sink = new FakeMonitorSink();
  const policy = new MonitorPolicy({ clock, config: { ...CONFIG, ...cfg }, sink });
  const lines = () => sink.sent.map((s) => s.batch.lines);
  const end = (id = "bg1", state: Task["state"] = "exited") => {
    const ev: TaskEvent = { type: "exit", code: 0, signal: null, at: 0 };
    policy.onTaskEvent({ id, state } as Task, ev, true);
  };
  return { clock, sink, policy, lines, end };
}

describe("lines", () => {
  it("reports every new line when no grep is given", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\nb\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["a", "b"]]);
  });

  it("reports only lines matching grep", () => {
    const s = setup();
    s.policy.start("bg1", { grep: /ERR/, maxNotifications: 10 });
    s.policy.onOutput("bg1", out("ok\nERR one\nfine\nERR two\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["ERR one", "ERR two"]]);
  });

  it("does not let a global or sticky grep flag skip lines", () => {
    const s = setup();
    s.policy.start("bg1", { grep: /x/g, maxNotifications: 10 });
    s.policy.onOutput("bg1", out("x1\nx2\nx3\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["x1", "x2", "x3"]]);
  });

  it("joins a line split across chunks, including inside a multi-byte character", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    const bytes = out("héllo wor");
    s.policy.onOutput("bg1", bytes.subarray(0, 2)); // cuts the two-byte "é"
    s.policy.onOutput("bg1", bytes.subarray(2));
    s.policy.onOutput("bg1", out("ld\nnext"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["héllo world"]]); // "next" is unterminated: held
  });

  it("strips ANSI and CRLF and keeps the last carriage-return overwrite", () => {
    const s = setup();
    s.policy.start("bg1", { grep: /^100%|^red$|^crlf$/, maxNotifications: 10 });
    s.policy.onOutput("bg1", out("\x1b[31mred\x1b[0m\n10%\r50%\r100%\ncrlf\r\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["red", "100%", "crlf"]]);
  });

  it("cuts a line longer than the limit", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a".repeat(MONITOR_LINE_MAX_CHARS) + "\n" + "b".repeat(MONITOR_LINE_MAX_CHARS + 1) + "\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    const [exact, cut] = s.lines()[0];
    expect(exact).toBe("a".repeat(MONITOR_LINE_MAX_CHARS));
    expect(cut).toHaveLength(MONITOR_LINE_MAX_CHARS);
    expect(cut.endsWith("...")).toBe(true);
  });

  it("ignores output before start, output of other tasks, and output after stop", () => {
    const s = setup();
    s.policy.onOutput("bg1", out("before\n"));
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg2", out("other task\n"));
    s.policy.onOutput("bg1", out("mine\n"));
    s.policy.stop("bg1");
    s.policy.onOutput("bg1", out("after\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([]);
  });

  it("holds an unterminated line only up to the bound, dropping the rest of it", () => {
    const s = setup();
    s.policy.start("bg1", { grep: /^a+Z$/, maxNotifications: 10 });
    for (let i = 0; i < 4; i++) s.policy.onOutput("bg1", out("a".repeat(50_000))); // 200k characters, no newline
    s.policy.onOutput("bg1", out("Z")); // arrives with the line already at the bound
    s.policy.onOutput("bg1", out("\nok\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.sink.sent).toHaveLength(0); // the tail "Z" was beyond the bound
    s.policy.stop("bg1");
    s.policy.start("bg1", { grep: /^a/, maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a".repeat(50_000)));
    s.policy.onOutput("bg1", out("a".repeat(50_000)));
    s.policy.onOutput("bg1", out("\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()[0][0]).toHaveLength(MONITOR_LINE_MAX_CHARS); // the head is kept (and cut for display)
  });

  it("skips the line that was half printed when the monitor started", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10, midLine: true });
    s.policy.onOutput("bg1", out("tail of old line\nnew\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["new"]]);
  });

  it("keeps a first complete line when the task was not mid-line", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10, midLine: false });
    s.policy.onOutput("bg1", out("first\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["first"]]);
  });
});

describe("batching", () => {
  it("sends one message per window, started by the first pending line", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\n"));
    s.clock.advance(MONITOR_BATCH_MS - 1);
    s.policy.onOutput("bg1", out("b\n"));
    expect(s.sink.sent).toHaveLength(0);
    s.clock.advance(1);
    expect(s.lines()).toEqual([["a", "b"]]);
    s.policy.onOutput("bg1", out("c\n")); // next window
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["a", "b"], ["c"]]);
  });

  it("arms no timer for output without a matching line", () => {
    const s = setup();
    s.policy.start("bg1", { grep: /x/, maxNotifications: 10 });
    s.policy.onOutput("bg1", out("nope\n"));
    expect(s.clock.pending()).toBe(0);
  });

  it("limits a message to the line cap and counts the rest", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    const n = MONITOR_MAX_LINES + 5;
    s.policy.onOutput("bg1", out(Array.from({ length: n }, (_, i) => `l${i}`).join("\n") + "\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.sink.sent[0].batch.lines).toHaveLength(MONITOR_MAX_LINES);
    expect(s.sink.sent[0].batch.lines[MONITOR_MAX_LINES - 1]).toBe(`l${MONITOR_MAX_LINES - 1}`);
    expect(s.sink.sent[0].batch.omitted).toBe(5);
    s.policy.onOutput("bg1", out("next\n")); // the count resets for the next window
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.sink.sent[1].batch).toMatchObject({ lines: ["next"], omitted: 0 });
  });

  it("passes the configured delivery and wake through", () => {
    const s = setup({ delivery: "followUp", wake: false });
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.sink.sent[0].opts).toEqual({ deliverAs: "followUp", triggerTurn: false });
  });
});

describe("limits and stop", () => {
  it("stops at max_notifications, and the last message says so", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 2 });
    for (const l of ["a", "b", "c"]) {
      s.policy.onOutput("bg1", out(`${l}\n`));
      s.clock.advance(MONITOR_BATCH_MS);
    }
    expect(s.lines()).toEqual([["a"], ["b"]]);
    expect(s.sink.sent.map((m) => m.batch.stopped)).toEqual([undefined, "max_notifications"]);
    expect(s.policy.active("bg1")).toBe(false);
  });

  it("stop sends nothing, drops pending lines and cancels the timer", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\n"));
    expect(s.policy.stop("bg1")).toBe(true);
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.sink.sent).toHaveLength(0);
  });

  it("stop reports whether a monitor was active", () => {
    const s = setup();
    expect(s.policy.stop("bg1")).toBe(false);
  });

  it("a second start replaces the first: new filter, pending lines dropped", () => {
    const s = setup();
    expect(s.policy.start("bg1", { grep: /a/, maxNotifications: 10 })).toEqual({ replaced: false });
    s.policy.onOutput("bg1", out("a1\n"));
    expect(s.policy.start("bg1", { grep: /b/, maxNotifications: 10 })).toEqual({ replaced: true });
    s.policy.onOutput("bg1", out("a2\nb1\n"));
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.lines()).toEqual([["b1"]]);
  });

  it("monitors are independent per task", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.start("bg2", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("one\n"));
    s.policy.onOutput("bg2", out("two\n"));
    s.policy.stop("bg1");
    s.clock.advance(MONITOR_BATCH_MS);
    expect(s.sink.sent.map((m) => [m.batch.id, m.batch.lines])).toEqual([["bg2", ["two"]]]);
  });

  it("disposeAll cancels timers and sends nothing", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.start("bg2", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\n"));
    s.policy.disposeAll();
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(MONITOR_BATCH_MS);
    s.end("bg1"); // a kill during shutdown arrives after disposal
    expect(s.sink.sent).toHaveLength(0);
    expect(s.policy.active("bg1") || s.policy.active("bg2")).toBe(false);
  });
});

describe("task end", () => {
  it("flushes pending lines at once, marks the message as the last, and stops", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\nb\n"));
    s.end();
    expect(s.sink.sent).toHaveLength(1);
    expect(s.sink.sent[0].batch).toMatchObject({ lines: ["a", "b"], stopped: "task_ended" });
    expect(s.clock.pending()).toBe(0);
    expect(s.policy.active("bg1")).toBe(false);
  });

  it("emits an unterminated last line", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("done\nlast without newline"));
    s.end();
    expect(s.lines()).toEqual([["done", "last without newline"]]);
  });

  it("applies grep to the unterminated last line", () => {
    const s = setup();
    s.policy.start("bg1", { grep: /ERR/, maxNotifications: 10 });
    s.policy.onOutput("bg1", out("fine"));
    s.end();
    expect(s.sink.sent).toHaveLength(0);
  });

  it("sends nothing when nothing is pending, and still stops", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.end();
    expect(s.sink.sent).toHaveLength(0);
    expect(s.policy.active("bg1")).toBe(false);
  });

  it("ignores non-terminal events, unapplied events and tasks without a monitor", () => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\n"));
    s.policy.onTaskEvent({ id: "bg1", state: "background" } as Task, { type: "output", bytes: 2, at: 0 }, true);
    s.policy.onTaskEvent({ id: "bg1", state: "exited" } as Task, { type: "notify_status", status: "sent" }, true);
    s.policy.onTaskEvent({ id: "bg1", state: "exited" } as Task, { type: "exit", code: 0, signal: null, at: 0 }, false);
    s.policy.onTaskEvent({ id: "bg9", state: "exited" } as Task, { type: "exit", code: 0, signal: null, at: 0 }, true);
    expect(s.sink.sent).toHaveLength(0);
    expect(s.policy.active("bg1")).toBe(true);
  });

  it.each<Task["state"]>(["exited", "killed", "timed_out", "spawn_failed"])("flushes on %s", (state) => {
    const s = setup();
    s.policy.start("bg1", { maxNotifications: 10 });
    s.policy.onOutput("bg1", out("a\n"));
    s.end("bg1", state);
    expect(s.lines()).toEqual([["a"]]);
  });
});
