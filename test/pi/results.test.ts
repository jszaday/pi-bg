import { describe, expect, it } from "vitest";
import type { Task, TaskSummary, WaitResult } from "../../src/contract.js";
import { RESULT_MAPPERS, toBashHandoffResult, toKillResult, toOutputResult, toStatusResult, toWaitResult } from "../../src/pi/results.js";
import type { WireHandoff, WireKill, WireOutput, WireStatus, WireWait } from "../../src/pi/results.js";
import { TOOL_NAMES } from "../../src/tools/schemas.js";

const summary: TaskSummary = {
  id: "bg1", label: "build", command: "make", state: "exited", startedAt: "2024-01-01T00:00:00.000Z", runtimeS: 5,
  exitCode: 0, totalBytes: 9, notify: "done", notified: false, logPath: "/tmp/bg1.log", logDegraded: false, lastLines: ["ok"],
};
const task = {
  id: "bg1", spec: { command: "make", cwd: "/", hardTimeoutMs: null, bgTimeoutMs: null, notify: "done", startInBackground: false },
  state: "background", startedAt: 1000, handoffAt: 31000, handoffReason: "bg_timeout", pid: 77, logPath: "/tmp/bg1.log",
  logDegraded: false, totalBytes: 0, notifyStatus: "none", notifyRedelivered: false,
} as Task;

describe("results mappers", () => {
  it("maps a handoff to details.pi_bg and snake_case structuredContent", () => {
    const r = toBashHandoffResult(task, ["a"], "bg_timeout", { truncation: null });
    expect(r.details).toEqual({ truncation: null, pi_bg: { task_id: "bg1", reason: "bg_timeout", log_path: "/tmp/bg1.log", pid: 77 } });
    const w = r.structuredContent as unknown as WireHandoff;
    expect(w).toEqual({ task_id: "bg1", state: "background", reason: "bg_timeout", runtime_s: 30, output_tail: ["a"], log_path: "/tmp/bg1.log", log_degraded: false });
    expect(r.content[0]).toMatchObject({ type: "text" });
    expect((r.content[0] as { text: string }).text).toContain("bg1");
  });
  it("omits pid and log_path when unknown", () => {
    const r = toBashHandoffResult({ ...task, pid: undefined, logPath: undefined }, [], "requested");
    expect(r.details).toEqual({ pi_bg: { task_id: "bg1", reason: "requested" } });
    expect(r.structuredContent).not.toHaveProperty("log_path");
  });
  it("maps status summaries to snake_case", () => {
    const w = toStatusResult([summary]).structuredContent as unknown as WireStatus;
    expect(w.tasks[0]).toEqual({
      id: "bg1", label: "build", command: "make", state: "exited", started_at: summary.startedAt, runtime_s: 5, exit_code: 0,
      total_bytes: 9, notify: "done", notified: false, log_path: "/tmp/bg1.log", log_degraded: false, last_lines: ["ok"],
    });
    expect(toStatusResult([]).content[0]).toMatchObject({ text: expect.stringContaining("No background tasks") });
  });
  it("maps output, with the degraded note appended", () => {
    const r = toOutputResult({ id: "bg1", state: "exited", exitCode: 1, output: "x", returnedBytes: 1, totalBytes: 1, nextCursor: 1, truncated: false, stream: "combined", logDegraded: true }, "NOTE");
    const w = r.structuredContent as unknown as WireOutput;
    expect(w).toEqual({ id: "bg1", state: "exited", exit_code: 1, output: "x", returned_bytes: 1, total_bytes: 1, next_cursor: 1, truncated: false, stream: "combined", log_degraded: true });
    expect((r.content[0] as { text: string }).text.endsWith("NOTE")).toBe(true);
  });
  it("converts waitedMs to waited_s", () => {
    const wr: WaitResult = { reason: "timeout", waitedMs: 2500, tasks: [] };
    const w = toWaitResult(wr, [summary]).structuredContent as unknown as WireWait;
    expect(w.reason).toBe("timeout");
    expect(w.waited_s).toBe(3);
    expect(w.tasks).toHaveLength(1);
  });
  it("maps kill to already_finished", () => {
    const w = toKillResult({ killed: ["bg1"], alreadyFinished: ["bg2"], failed: [{ id: "bg3", error: "e" }] }).structuredContent as unknown as WireKill;
    expect(w).toEqual({ killed: ["bg1"], already_finished: ["bg2"], failed: [{ id: "bg3", error: "e" }] });
  });
  it("RESULT_MAPPERS has one entry per tool name", () => {
    expect(Object.keys(RESULT_MAPPERS).sort()).toEqual([...TOOL_NAMES].sort());
  });
  it("wire shapes are declared with the documented keys (compile-time check)", () => {
    const status = { tasks: [] } satisfies WireStatus;
    const kill = { killed: [], already_finished: [], failed: [] } satisfies WireKill;
    expect(Object.keys(status.tasks)).toEqual([]);
    expect(Object.keys(kill)).toEqual(["killed", "already_finished", "failed"]);
  });
});
