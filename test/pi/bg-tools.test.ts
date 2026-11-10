import { describe, expect, it } from "vitest";
import { MAX_WRITE_BYTES, registerBgTools } from "../../src/pi/bg-tools.js";
import { makeHarness, type Harness } from "./w6a-services.js";

const exit0 = { code: 0, signal: null };
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");
const sc = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, any>;

function setup(o: Parameters<typeof makeHarness>[0] = {}): Harness {
  const h = makeHarness(o);
  registerBgTools(h.pi.asExtensionAPI(), h.s);
  return h;
}
const call = (h: Harness, name: string, params: unknown, opts: Parameters<Harness["pi"]["callTool"]>[2] = {}) =>
  h.pi.callTool(name, params, opts);

describe("registration and validation", () => {
  it("registers the five tools with snake_case schemas", async () => {
    const h = setup();
    expect([...h.pi.tools.keys()].sort()).toEqual(["bg_kill", "bg_output", "bg_status", "bg_wait", "bg_write"]);
    await expect(call(h, "bg_output", {})).rejects.toThrow(/schema/); // id required
    await expect(call(h, "bg_status", { tailLines: 3, tail_lines: "x" })).rejects.toThrow(/schema/);
    await expect(call(h, "bg_wait", { timeout_s: 5000 })).rejects.toThrow(/schema/);
  });
  it("refreshes s.ctx.current at each execute", async () => {
    const h = setup();
    expect(h.s.ctx.current).toBeUndefined();
    await call(h, "bg_status", {});
    expect(h.s.ctx.current).toBeDefined();
  });
});

describe("inactive", () => {
  it("answers inactive when inactiveReason is set or config disabled, for every tool", async () => {
    const h = setup();
    h.s.inactiveReason = () => "pi-bg is inactive: bash is owned by other-ext; there are no background tasks.";
    for (const [n, p] of [["bg_status", {}], ["bg_output", { id: "bg1" }], ["bg_wait", {}], ["bg_kill", { all: true }], ["bg_write", { id: "bg1", data: "x" }]] as const) {
      await expect(call(h, n, p)).rejects.toThrow(/owned by other-ext/);
    }
    h.s.inactiveReason = undefined;
    h.config.enabled = false;
    await expect(call(h, "bg_status", {})).rejects.toThrow(/inactive.*Action/s);
    expect(h.ui.msgs.length).toBe(6);
  });
});

describe("bg_status", () => {
  it("lists tasks in snake_case, no tails by default, and filters finished", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "hi\n", exit: exit0 }]);
    h.start("b", [{ at: 0, chunk: "yo\n" }]);
    await h.flush();
    const r = await call(h, "bg_status", { include_finished: true });
    const tasks = sc(r).tasks;
    expect(tasks.map((t: any) => t.id)).toEqual(["bg2", "bg1"]); // running first
    expect(tasks[1]).toMatchObject({ state: "exited", exit_code: 0, total_bytes: 3, log_degraded: false });
    expect(tasks[1].last_lines).toBeUndefined();
    expect(text(r)).toContain("bg1");
    const running = await call(h, "bg_status", { tail_lines: 1 });
    expect(sc(running).hidden_finished).toBe(1);
    expect(text(running)).toContain("1 finished task(s) hidden");
    expect(sc(running).tasks.map((t: any) => t.id)).toEqual(["bg2"]);
    expect(sc(running).tasks[0].last_lines).toEqual(["yo"]);
  });
  it("orders running before finished, newest first, and pages with limit and offset", async () => {
    const h = setup();
    h.start("a", [{ at: 0, exit: exit0 }]);
    for (const c of ["b", "c", "d"]) h.start(c);
    await h.flush();
    const p1 = await call(h, "bg_status", { include_finished: true, limit: 2 });
    expect(sc(p1).tasks.map((t: any) => t.id)).toEqual(["bg4", "bg3"]);
    expect(sc(p1)).toMatchObject({ total: 4, next_offset: 2 });
    expect(text(p1)).toContain("Showing 1-2 of 4. Use offset 2 for the next page.");
    const p2 = await call(h, "bg_status", { include_finished: true, limit: 2, offset: 2 });
    expect(sc(p2).tasks.map((t: any) => t.id)).toEqual(["bg2", "bg1"]);
    expect(sc(p2).next_offset).toBeUndefined();
  });
  it("shows one task with a 10-line tail by default", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n") + "\n" }]);
    const r = await call(h, "bg_status", { id: "bg1" });
    expect(sc(r).tasks[0].last_lines).toHaveLength(10);
    expect(text(r)).toContain("l14");
    expect(text(r)).not.toContain("l4\n");
  });
  it("fails with unknown_id and stale_id", async () => {
    const h = setup({ seed: 2 });
    h.start("a");
    await expect(call(h, "bg_status", { id: "bg9" })).rejects.toThrow(/No task bg9.*Known: bg3/s);
    await expect(call(h, "bg_status", { id: "bg1" })).rejects.toThrow(/started before this session was resumed/);
  });
  it("marks terminal tasks as seen (not running ones)", async () => {
    const h = setup();
    h.start("a", [{ at: 0, exit: exit0 }]);
    h.start("b");
    await h.flush();
    await call(h, "bg_status", { include_finished: true });
    expect(h.markSaw.mock.calls.map((c) => c[0])).toEqual(["bg1"]);
    expect(h.s.registry.get("bg1")?.notifyStatus).toBe("suppressed");
    expect(h.sink.sent).toHaveLength(0);
    h.markSaw.mockClear();
    await call(h, "bg_status", { id: "bg1" });
    expect(h.markSaw).toHaveBeenCalledWith("bg1");
  });
  it("falls back to the log for a task whose runtime was cleaned up", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "from-log\n", exit: exit0 }]);
    await h.flush();
    h.s.runtime.delete("bg1");
    expect(sc(await call(h, "bg_status", { id: "bg1" })).tasks[0].last_lines).toEqual(["from-log"]);
  });
});

describe("bg_output", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line${i}`).join("\n") + "\n";
  it("returns the tail in snake_case with a cursor", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: lines(60), exit: exit0 }]);
    await h.flush();
    const r = await call(h, "bg_output", { id: "bg1" });
    const w = sc(r);
    expect(w.output.split("\n")).toHaveLength(50);
    expect(w.output.endsWith("line59")).toBe(true);
    expect(w).toMatchObject({ id: "bg1", state: "exited", exit_code: 0, stream: "combined", truncated: false, log_degraded: false, log_path: "mem://bg1" });
    expect(w.next_cursor).toBe(w.total_bytes);
    expect(w.returned_bytes).toBe(w.output.length);
    const small = await call(h, "bg_output", { id: "bg1", tail_lines: 2 });
    expect(sc(small).output).toBe("line58\nline59");
  });
  it("reads incrementally with since and withholds a half-written line", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "one\ntw" }, { at: 10, chunk: "o\nthr" }, { at: 20, chunk: "ee\n", exit: exit0 }]);
    const a = sc(await call(h, "bg_output", { id: "bg1", since: 0 }));
    expect(a.output).toBe("one");
    expect(a.next_cursor).toBe(4);
    h.clock.advance(10);
    const b = sc(await call(h, "bg_output", { id: "bg1", since: a.next_cursor }));
    expect(b.output).toBe("two");
    expect(b.next_cursor).toBe(8);
    h.clock.advance(10);
    await h.flush();
    const c = sc(await call(h, "bg_output", { id: "bg1", since: b.next_cursor }));
    expect(c.output).toBe("three");
    expect(c.next_cursor).toBe(14);
  });
  it("releases a trailing partial line once the task ended", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "x\nlast", exit: exit0 }]);
    await h.flush();
    expect(sc(await call(h, "bg_output", { id: "bg1", since: 0 })).output).toBe("x\nlast");
  });
  it("caps with max_bytes and sets truncated and a resumable cursor", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: lines(20), exit: exit0 }]);
    await h.flush();
    const a = sc(await call(h, "bg_output", { id: "bg1", since: 0, max_bytes: 30 }));
    expect(a.truncated).toBe(true);
    expect(a.returned_bytes).toBeLessThanOrEqual(30);
    const b = sc(await call(h, "bg_output", { id: "bg1", since: a.next_cursor, max_bytes: 10_000 }));
    expect((a.output + "\n" + b.output).split("\n")).toHaveLength(20);
    const tail = sc(await call(h, "bg_output", { id: "bg1", max_bytes: 20 }));
    expect(tail.truncated).toBe(true);
    expect(tail.output.endsWith("line19")).toBe(true);
  });
  it("greps with context", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "a\nERR one\nb\nc\nd\nERR two\n", exit: exit0 }]);
    await h.flush();
    expect(sc(await call(h, "bg_output", { id: "bg1", grep: "ERR" })).output).toBe("ERR one\nERR two");
    expect(sc(await call(h, "bg_output", { id: "bg1", grep: "ERR", context: 1 })).output).toBe("a\nERR one\nb\n--\nd\nERR two");
  });
  it("fails on a bad regex, unknown and stale ids", async () => {
    const h = setup({ seed: 1 });
    h.start("a");
    await expect(call(h, "bg_output", { id: "bg2", grep: "(" })).rejects.toThrow(/Invalid grep pattern \(.*Action/s);
    await expect(call(h, "bg_output", { id: "bg7" })).rejects.toThrow(/No task bg7/);
    await expect(call(h, "bg_output", { id: "bg1" })).rejects.toThrow(/started before/);
  });
  it("normalizes ANSI and carriage-return progress", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "\x1b[31mred\x1b[0m\n10%\r50%\r100%\n", exit: exit0 }]);
    await h.flush();
    expect(sc(await call(h, "bg_output", { id: "bg1" })).output).toBe("red\n100%");
  });
  it("uses stdout/stderr only with a splitting runner, else combined", async () => {
    const split = setup();
    split.start("a", [{ at: 0, chunk: "out\n", stream: "stdout" }, { at: 0, chunk: "err\n", stream: "stderr", exit: exit0 }]);
    await split.flush();
    expect(sc(await call(split, "bg_output", { id: "bg1", stream: "stderr" }))).toMatchObject({ output: "err", stream: "stderr" });
    const comb = setup({ caps: { splitStreams: false } });
    comb.start("a", [{ at: 0, chunk: "out\n", exit: exit0 }]);
    await comb.flush();
    expect(sc(await call(comb, "bg_output", { id: "bg1", stream: "stderr" }))).toMatchObject({ output: "out", stream: "combined" });
    const fallback = await call(comb, "bg_output", { id: "bg1", stream: "stderr" });
    expect(text(fallback)).toContain("Stream stderr was requested, but this runner only provides combined output");
    expect(text(fallback)).toContain("Action: omit stream or use combined.");
  });
  it("falls back to the ring when the log is degraded or missing, and says so", async () => {
    const h = setup();
    h.start("a", [{ at: 0, chunk: "ring-only\n" }], { log: false });
    const w = sc(await call(h, "bg_output", { id: "bg1" }));
    expect(w).toMatchObject({ output: "ring-only", log_degraded: true });
    const r = await call(h, "bg_output", { id: "bg1" });
    expect(text(r)).toContain("Writing the log for bg1 failed");
    const none = sc(await call(h, "bg_output", { id: "bg1", since: w.total_bytes }));
    expect(none.output).toBe("");
  });
  it("marks a terminal task as seen", async () => {
    const h = setup();
    h.start("a", [{ at: 0, exit: exit0 }]);
    await h.flush();
    await call(h, "bg_output", { id: "bg1" });
    expect(h.markSaw).toHaveBeenCalledWith("bg1");
    expect(h.sink.sent).toHaveLength(0);
  });
});

describe("bg_wait", () => {
  it("returns no_tasks when nothing is running", async () => {
    const h = setup();
    const r = await call(h, "bg_wait", {});
    expect(sc(r)).toMatchObject({ reason: "no_tasks", waited_s: 0, tasks: [] });
    expect(text(r)).toContain("No background task is running");
  });
  it("is released by finished, with a 10-line tail, and marks the task seen", async () => {
    const h = setup();
    const out = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n") + "\n";
    h.start("a", [{ at: 0, chunk: out }, { at: 2000, exit: exit0 }]);
    h.start("b");
    const p = call(h, "bg_wait", {});
    await h.flush();
    h.clock.advance(2000);
    const r = await p;
    expect(sc(r).reason).toBe("finished");
    expect(sc(r).waited_s).toBe(2);
    expect(sc(r).tasks.map((t: any) => t.id)).toEqual(["bg1", "bg2"]);
    expect(sc(r).tasks[0].last_lines).toHaveLength(10);
    expect(sc(r).tasks[1].last_lines).toBeUndefined();
    expect(h.markSaw.mock.calls.map((c) => c[0])).toEqual(["bg1"]);
    expect(h.sink.sent).toHaveLength(0);
  });
  it("honors mode all and explicit ids", async () => {
    const h = setup();
    h.start("a", [{ at: 1000, exit: exit0 }]);
    h.start("b", [{ at: 3000, exit: exit0 }]);
    const p = call(h, "bg_wait", { ids: ["bg1", "bg2"], mode: "all" });
    await h.flush();
    h.clock.advance(1000);
    await h.flush();
    h.clock.advance(2000);
    expect(sc(await p)).toMatchObject({ reason: "finished", waited_s: 3 });
  });
  it("times out with the default timeout and clamps to the maximum", async () => {
    const h = setup();
    h.start("a");
    const p = call(h, "bg_wait", {});
    await h.flush();
    h.clock.advance(119_999);
    h.clock.advance(1);
    const r = await p;
    expect(sc(r)).toMatchObject({ reason: "timeout", waited_s: 120 });
    expect(text(r)).toContain("timed out");
    expect(h.markSaw).not.toHaveBeenCalled();
    h.config.wait.maxTimeoutSeconds = 10;
    const q = call(h, "bg_wait", { timeout_s: 3000 });
    await h.flush();
    h.clock.advance(10_000);
    expect(sc(await q)).toMatchObject({ reason: "timeout", waited_s: 10 });
    expect(await call(h, "bg_wait", { timeout_s: 0 }).then(sc)).toMatchObject({ reason: "timeout", waited_s: 0 });
  });
  it("is released by a user message", async () => {
    const h = setup();
    h.start("a");
    h.pi.pendingMessages = 1;
    const p = call(h, "bg_wait", {});
    await h.flush();
    h.s.waits.onUserMessage();
    h.clock.advance(50);
    const r = await p;
    expect(sc(r).reason).toBe("user_message");
    expect(text(r)).toContain("user sent a message");
  });
  it("is released by abort and leaves the task running", async () => {
    const h = setup();
    h.start("a");
    const ac = new AbortController();
    const p = call(h, "bg_wait", {}, { signal: ac.signal });
    await h.flush();
    ac.abort();
    expect(sc(await p).reason).toBe("aborted");
    expect(h.s.registry.get("bg1")?.state).toBe("background");
    expect(h.runner.kills).toEqual([]);
  });
  it("fails for unknown and stale explicit ids", async () => {
    const h = setup({ seed: 1 });
    h.start("a");
    await expect(call(h, "bg_wait", { ids: ["bg2", "bg9"] })).rejects.toThrow(/No task bg9/);
    await expect(call(h, "bg_wait", { ids: ["bg1"] })).rejects.toThrow(/started before/);
  });
});

describe("bg_kill", () => {
  it("kills one task by id and marks it seen", async () => {
    const h = setup();
    h.start("a");
    h.start("b");
    const r = await call(h, "bg_kill", { id: "bg1" });
    expect(sc(r)).toEqual({ killed: ["bg1"], already_finished: [], failed: [] });
    expect(text(r)).toContain("Killed: bg1");
    expect(h.s.registry.get("bg1")?.killCause).toBe("bg_kill");
    expect(h.s.registry.get("bg2")?.state).toBe("background");
    await h.flush();
    expect(h.s.registry.get("bg1")?.notifyStatus).toBe("suppressed");
    expect(h.sink.sent).toHaveLength(0);
  });
  it("kills all running tasks", async () => {
    const h = setup();
    h.start("a");
    h.start("b");
    h.start("c", [{ at: 0, exit: exit0 }]);
    await h.flush();
    const r = await call(h, "bg_kill", { all: true });
    expect(sc(r).killed.sort()).toEqual(["bg1", "bg2"]);
    expect(h.markSaw.mock.calls.map((c) => c[0]).sort()).toEqual(["bg1", "bg2"]);
  });
  it("sends the chosen signal and the default stays TERM", async () => {
    const h = setup();
    h.start("a");
    h.start("b");
    expect(sc(await call(h, "bg_kill", { id: "bg1", signal: "HUP" })).killed).toEqual(["bg1"]);
    expect(sc(await call(h, "bg_kill", { id: "bg2" })).killed).toEqual(["bg2"]);
    expect(h.runner.kills).toEqual(["hup", "term"]);
  });
  it("accepts KILL on the fallback runner but rejects other signals with cause and action", async () => {
    const h = setup({ caps: { gracefulTerm: false } });
    h.start("a");
    await expect(call(h, "bg_kill", { id: "bg1", signal: "INT" })).rejects.toThrow(/cannot send SIGINT.*fallback runner.*Action: call bg_kill with signal KILL/s);
    await expect(call(h, "bg_kill", { all: true, signal: "TERM" })).rejects.toThrow(/cannot send SIGTERM/);
    expect(h.runner.kills).toEqual([]);
    expect(h.s.registry.get("bg1")?.state).toBe("background");
    expect(sc(await call(h, "bg_kill", { id: "bg1", signal: "KILL" })).killed).toEqual(["bg1"]);
    expect(h.runner.kills).toEqual(["kill"]);
  });
  it("rejects an unknown signal at the schema", async () => {
    const h = setup();
    h.start("a");
    await expect(call(h, "bg_kill", { id: "bg1", signal: "STOP" })).rejects.toThrow(/schema/);
    expect(h.runner.kills).toEqual([]);
  });
  it("lists a finished task as already_finished and marks it seen", async () => {
    const h = setup();
    h.start("a", [{ at: 0, exit: exit0 }]);
    await h.flush();
    const r = await call(h, "bg_kill", { id: "bg1" });
    expect(sc(r)).toEqual({ killed: [], already_finished: ["bg1"], failed: [] });
    expect(h.markSaw).toHaveBeenCalledWith("bg1");
    expect(h.runner.kills).toEqual([]);
  });
  it("rejects id with all, and neither, naming the action", async () => {
    const h = setup();
    h.start("a");
    await expect(call(h, "bg_kill", { id: "bg1", all: true })).rejects.toThrow(/not both.*Action/s);
    await expect(call(h, "bg_kill", {})).rejects.toThrow(/exactly one of id or all.*Action/s);
    await expect(call(h, "bg_kill", { all: false })).rejects.toThrow(/exactly one/);
    expect(h.runner.kills).toEqual([]);
  });
  it("fails for unknown and stale ids", async () => {
    const h = setup({ seed: 1 });
    await expect(call(h, "bg_kill", { id: "bg5" })).rejects.toThrow(/No task bg5/);
    await expect(call(h, "bg_kill", { id: "bg1" })).rejects.toThrow(/started before/);
  });
});

describe("bg_write", () => {
  it("writes to a task started with stdin and closes it on eof", async () => {
    const h = setup();
    h.start("repl", [], { stdin: true });
    const r = await call(h, "bg_write", { id: "bg1", data: "héllo\n" });
    expect(sc(r)).toEqual({ id: "bg1", written_bytes: 7, eof: false });
    expect(text(r)).toBe("Wrote 7 bytes to the stdin of bg1.");
    const r2 = await call(h, "bg_write", { id: "bg1", data: "", eof: true });
    expect(sc(r2)).toEqual({ id: "bg1", written_bytes: 0, eof: true });
    expect(text(r2)).toContain("Closed stdin");
    expect(h.runner.writes).toEqual([{ data: "héllo\n", eof: false }, { data: "", eof: true }]);
  });
  it("accepts exactly the size limit and rejects one byte more, writing nothing", async () => {
    const h = setup();
    h.start("repl", [], { stdin: true });
    expect(sc(await call(h, "bg_write", { id: "bg1", data: "x".repeat(MAX_WRITE_BYTES) })).written_bytes).toBe(MAX_WRITE_BYTES);
    await expect(call(h, "bg_write", { id: "bg1", data: "x".repeat(MAX_WRITE_BYTES + 1) })).rejects.toThrow(/65537 bytes.*65536-byte limit.*Action: split/s);
    expect(h.runner.writes).toHaveLength(1);
  });
  it("counts bytes, not characters", async () => {
    const h = setup();
    h.start("repl", [], { stdin: true });
    await expect(call(h, "bg_write", { id: "bg1", data: "é".repeat(MAX_WRITE_BYTES / 2 + 1) })).rejects.toThrow(/limit/);
  });
  it("fails for a task started without stdin, naming cause and action", async () => {
    const h = setup();
    h.start("plain");
    await expect(call(h, "bg_write", { id: "bg1", data: "x" })).rejects.toThrow(/bg1 was not started with stdin.*Action: start the command again with bash stdin true/s);
    expect(h.runner.writes).toEqual([]);
    expect(h.ui.msgs.some((m) => m.includes("not started with stdin"))).toBe(true);
  });
  it("fails for an exited task", async () => {
    const h = setup();
    h.start("repl", [{ at: 0, exit: exit0 }], { stdin: true });
    await h.flush();
    await expect(call(h, "bg_write", { id: "bg1", data: "x" })).rejects.toThrow(/bg1 has already ended \(exited\).*Action: use bg_output/s);
    expect(h.runner.writes).toEqual([]);
  });
  it("fails after eof, relaying the runner's cause with an action", async () => {
    const h = setup();
    h.start("repl", [], { stdin: true });
    await call(h, "bg_write", { id: "bg1", data: "", eof: true });
    await expect(call(h, "bg_write", { id: "bg1", data: "more" })).rejects.toThrow(/Could not write to the stdin of bg1: stdin was already closed.*Action: read the output with bg_output/s);
  });
  it("fails for unknown and stale ids and for a missing data field", async () => {
    const h = setup({ seed: 1 });
    await expect(call(h, "bg_write", { id: "bg5", data: "x" })).rejects.toThrow(/No task bg5/);
    await expect(call(h, "bg_write", { id: "bg1", data: "x" })).rejects.toThrow(/started before/);
    await expect(call(h, "bg_write", { id: "bg5" })).rejects.toThrow(/schema/);
  });
});
