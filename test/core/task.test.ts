import { describe, expect, it } from "vitest";
import type { KillCause, NotifyStatus, Task, TaskEvent, TaskSpec } from "../../src/contract.js";
import { isTerminal, newTask, reduce } from "../../src/core/task.js";

const spec = (over: Partial<TaskSpec> = {}): TaskSpec => ({
  command: "sleep 1",
  cwd: "/tmp",
  hardTimeoutMs: null,
  bgTimeoutMs: 30_000,
  notify: "done",
  startInBackground: false,
  ...over,
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAUSES: KillCause[] = ["bg_kill", "command", "shutdown", "turn_abort"];
const STATUSES: NotifyStatus[] = ["none", "pending", "sent", "acked", "suppressed"];

function randomEvent(rnd: () => number, at: number): TaskEvent {
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  switch (Math.floor(rnd() * 9)) {
    case 0: return { type: "handoff", reason: pick(["requested", "bg_timeout", "user"] as const), at };
    case 1: return { type: "output", bytes: Math.floor(rnd() * 100), at };
    case 2: return { type: "pid", pid: 1 + Math.floor(rnd() * 5) };
    case 3: return { type: "kill_requested", cause: pick(CAUSES), at };
    case 4: return { type: "hard_timeout", at };
    case 5: return { type: "exit", code: rnd() < 0.5 ? 0 : 1, signal: null, at };
    case 6: return { type: "spawn_failed", error: "boom", at };
    case 7: return { type: "log_degraded", error: "disk" };
    default: return { type: "notify_status", status: pick(STATUSES) };
  }
}

const exit = (at = 10, code: number | null = 0, signal: string | null = null): TaskEvent => ({ type: "exit", code, signal, at });

describe("newTask", () => {
  it("starts in the foreground with zeroed counters", () => {
    const t = newTask("bg1", spec(), 5);
    expect(t).toMatchObject({ id: "bg1", state: "foreground", startedAt: 5, logDegraded: false, totalBytes: 0, notifyStatus: "none", notifyRedelivered: false });
    expect(t.handoffReason).toBeUndefined();
  });
  it("startInBackground yields background with reason requested", () => {
    const t = newTask("bg1", spec({ startInBackground: true }), 5);
    expect(t).toMatchObject({ state: "background", handoffReason: "requested", handoffAt: 5 });
  });
});

describe("reduce: transitions", () => {
  it("handoff moves foreground to background once", () => {
    const t0 = newTask("bg1", spec(), 0);
    const r = reduce(t0, { type: "handoff", reason: "user", at: 7 });
    expect(r.applied).toBe(true);
    expect(r.task).toMatchObject({ state: "background", handoffReason: "user", handoffAt: 7 });
    const again = reduce(r.task, { type: "handoff", reason: "bg_timeout", at: 9 });
    expect(again.applied).toBe(false);
    expect(again.task.handoffReason).toBe("user");
  });
  it("does not mutate its input", () => {
    const t0 = newTask("bg1", spec(), 0);
    const snap = JSON.stringify(t0);
    reduce(t0, { type: "handoff", reason: "user", at: 7 });
    reduce(t0, exit());
    expect(JSON.stringify(t0)).toBe(snap);
  });
  it("accumulates output bytes and records pid", () => {
    let t = newTask("bg1", spec(), 0);
    t = reduce(t, { type: "output", bytes: 10, at: 1 }).task;
    t = reduce(t, { type: "output", bytes: 5, at: 2 }).task;
    t = reduce(t, { type: "pid", pid: 42 }).task;
    expect(t).toMatchObject({ totalBytes: 15, pid: 42 });
    expect(reduce(t, { type: "pid", pid: 42 }).applied).toBe(false);
  });
  it("log_path sets logPath once; same path is not applied; ignored after the end", () => {
    const t0 = newTask("bg1", spec(), 0);
    const r = reduce(t0, { type: "log_path", path: "/tmp/bg1.log" });
    expect(r.applied).toBe(true);
    expect(r.task.logPath).toBe("/tmp/bg1.log");
    expect(reduce(r.task, { type: "log_path", path: "/tmp/bg1.log" }).applied).toBe(false);
    const done = reduce(t0, exit()).task;
    const late = reduce(done, { type: "log_path", path: "/tmp/x.log" });
    expect(late.applied).toBe(false);
    expect(late.task.logPath).toBeUndefined();
  });
  it("exit without a request is exited, with code and signal", () => {
    const r = reduce(newTask("bg1", spec(), 0), exit(9, 3, null));
    expect(r.task).toMatchObject({ state: "exited", exitCode: 3, signal: null, endedAt: 9 });
    expect(isTerminal(r.task)).toBe(true);
  });
  it("kill_requested then exit is killed; exit then kill_requested stays exited", () => {
    const base = newTask("bg1", spec(), 0);
    const k = reduce(base, { type: "kill_requested", cause: "bg_kill", at: 1 });
    expect(k.applied).toBe(true);
    expect(k.task.state).toBe("foreground"); // not terminal until the exit arrives
    expect(reduce(k.task, exit(2, null, "SIGTERM")).task).toMatchObject({ state: "killed", killCause: "bg_kill", signal: "SIGTERM" });
    const done = reduce(base, exit(2)).task;
    const late = reduce(done, { type: "kill_requested", cause: "bg_kill", at: 3 });
    expect(late.applied).toBe(false);
    expect(late.task.state).toBe("exited");
    expect(late.task.killCause).toBeUndefined();
  });
  it("hard_timeout then exit is timed_out", () => {
    const t = reduce(newTask("bg1", spec(), 0), { type: "hard_timeout", at: 1 }).task;
    expect(t.hardTimeoutFired).toBe(true);
    expect(reduce(t, exit(2, null, "SIGKILL")).task.state).toBe("timed_out");
  });
  it("first stop cause wins when a kill and a hard timeout race", () => {
    const a = reduce(newTask("bg1", spec(), 0), { type: "kill_requested", cause: "command", at: 1 }).task;
    const a2 = reduce(a, { type: "hard_timeout", at: 2 });
    expect(a2.applied).toBe(false);
    expect(reduce(a2.task, exit()).task.state).toBe("killed");
    const b = reduce(newTask("bg1", spec(), 0), { type: "hard_timeout", at: 1 }).task;
    const b2 = reduce(b, { type: "kill_requested", cause: "shutdown", at: 2 });
    expect(b2.applied).toBe(false);
    expect(reduce(b2.task, exit()).task.state).toBe("timed_out");
  });
  it("a repeated kill_requested keeps the first cause", () => {
    let t = reduce(newTask("bg1", spec(), 0), { type: "kill_requested", cause: "bg_kill", at: 1 }).task;
    const r = reduce(t, { type: "kill_requested", cause: "shutdown", at: 2 });
    expect(r.applied).toBe(false);
    expect(r.task.killCause).toBe("bg_kill");
  });
  it("spawn_failed is terminal with the error", () => {
    const r = reduce(newTask("bg1", spec(), 0), { type: "spawn_failed", error: "ENOENT", at: 4 });
    expect(r.task).toMatchObject({ state: "spawn_failed", error: "ENOENT", endedAt: 4 });
  });
  it("log_degraded applies once, also after the end", () => {
    const done = reduce(newTask("bg1", spec(), 0), exit()).task;
    const r = reduce(done, { type: "log_degraded", error: "disk full" });
    expect(r.applied).toBe(true);
    expect(r.task.logDegraded).toBe(true);
    expect(reduce(r.task, { type: "log_degraded", error: "again" }).applied).toBe(false);
  });
});

describe("reduce: notify_status", () => {
  const status = (t: Task, s: NotifyStatus) => reduce(t, { type: "notify_status", status: s });
  const done = () => reduce(newTask("bg1", spec(), 0), exit()).task;
  it("applies after the task ended and moves forward", () => {
    let t = done();
    for (const s of ["pending", "sent", "acked"] as const) {
      const r = status(t, s);
      expect(r.applied).toBe(true);
      t = r.task;
    }
    expect(t.notifyStatus).toBe("acked");
    expect(t.state).toBe("exited");
  });
  it("same status is not applied; acked and suppressed are final", () => {
    expect(status(done(), "none").applied).toBe(false);
    const acked = status(done(), "acked").task;
    expect(status(acked, "pending").applied).toBe(false);
    expect(status(acked, "suppressed").applied).toBe(false);
    const sup = status(done(), "suppressed").task;
    expect(status(sup, "sent").applied).toBe(false);
  });
  it("sent -> pending is the one redelivery; a second loss is not retried", () => {
    const sent = status(status(done(), "pending").task, "sent").task;
    const re = status(sent, "pending");
    expect(re.applied).toBe(true);
    expect(re.task).toMatchObject({ notifyStatus: "pending", notifyRedelivered: true });
    const sent2 = status(re.task, "sent").task;
    const again = status(sent2, "pending");
    expect(again.applied).toBe(false);
    expect(again.task.notifyStatus).toBe("sent");
  });
  it("never moves back to none", () => {
    expect(status(status(done(), "pending").task, "none").applied).toBe(false);
  });
});

describe("reduce: properties (seeded random event sequences)", () => {
  const runs = 300;
  const sequences = (seed: number) => {
    const rnd = mulberry32(seed);
    return Array.from({ length: runs }, () => {
      const n = 1 + Math.floor(rnd() * 14);
      return Array.from({ length: n }, (_, i) => randomEvent(rnd, i + 1));
    });
  };

  it("terminal states absorb: after the first terminal state, state and exit data never change", () => {
    for (const seq of sequences(1)) {
      let t = newTask("bg1", spec({ startInBackground: seq.length % 2 === 0 }), 0);
      let frozen: Task | undefined;
      for (const ev of seq) {
        const r = reduce(t, ev);
        if (frozen) {
          expect(r.task.state).toBe(frozen.state);
          expect(r.task.exitCode).toBe(frozen.exitCode);
          expect(r.task.signal).toBe(frozen.signal);
          expect(r.task.endedAt).toBe(frozen.endedAt);
          expect(r.task.totalBytes).toBe(frozen.totalBytes);
          expect(r.task.killCause).toBe(frozen.killCause);
          if (ev.type !== "notify_status" && ev.type !== "log_degraded") expect(r.applied).toBe(false);
        }
        t = r.task;
        if (!frozen && isTerminal(t)) frozen = t;
      }
    }
  });

  it("handoff after a terminal state is a no-op: applied false, task unchanged", () => {
    for (const seq of sequences(2)) {
      let t = newTask("bg1", spec(), 0);
      for (const ev of seq) t = reduce(t, ev).task;
      if (!isTerminal(t)) t = reduce(t, exit(99)).task;
      const r = reduce(t, { type: "handoff", reason: "user", at: 1000 });
      expect(r.applied).toBe(false);
      expect(r.task).toBe(t);
    }
  });

  it("exit yields killed iff a kill was requested first, else timed_out iff hard timeout fired, else exited", () => {
    for (const seq of sequences(3)) {
      let t = newTask("bg1", spec(), 0);
      for (const ev of seq) {
        if (isTerminal(t)) break;
        t = reduce(t, ev).task;
      }
      if (isTerminal(t)) continue;
      const expected = t.killCause !== undefined ? "killed" : t.hardTimeoutFired ? "timed_out" : "exited";
      expect(reduce(t, exit(50)).task.state).toBe(expected);
    }
  });

  it("kill request before exit gives killed, after exit gives exited (every cause)", () => {
    for (const cause of CAUSES) {
      const base = newTask("bg1", spec(), 0);
      const before = reduce(reduce(base, { type: "kill_requested", cause, at: 1 }).task, exit(2));
      expect(before.task).toMatchObject({ state: "killed", killCause: cause });
      const after = reduce(reduce(base, exit(2)).task, { type: "kill_requested", cause, at: 3 });
      expect(after.task.state).toBe("exited");
      expect(after.applied).toBe(false);
    }
  });

  it("totalBytes never decreases and equals the sum of applied output before the end", () => {
    for (const seq of sequences(4)) {
      let t = newTask("bg1", spec(), 0);
      let sum = 0;
      for (const ev of seq) {
        const before = t.totalBytes;
        const r = reduce(t, ev);
        if (ev.type === "output" && r.applied) sum += ev.bytes;
        expect(r.task.totalBytes).toBeGreaterThanOrEqual(before);
        t = r.task;
      }
      expect(t.totalBytes).toBe(sum);
    }
  });

  it("applied is false exactly when the task object is returned unchanged", () => {
    for (const seq of sequences(5)) {
      let t = newTask("bg1", spec(), 0);
      for (const ev of seq) {
        const r = reduce(t, ev);
        if (!r.applied) expect(r.task).toBe(t);
        else expect(r.task).not.toBe(t);
        t = r.task;
      }
    }
  });
});
