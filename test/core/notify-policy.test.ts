import { describe, expect, it } from "vitest";
import type { BgConfig, KillCause, NotifyLevel, Task, TaskEvent, TaskId, TaskSummary } from "../../src/contract.js";
import { createIdAllocator } from "../../src/core/ids.js";
import { isErrorOutcome, NotificationPolicy } from "../../src/core/notify-policy.js";
import { TaskRegistry } from "../../src/core/registry.js";
import { FakeClock, FakeNotificationSink } from "../fakes/index.js";

// Real W1 registry, wrapped to create tasks with sequential ids and a status log.
class Reg extends TaskRegistry {
  statusLog: [TaskId, string][] = [];
  constructor(clock: FakeClock) {
    super({ clock, ids: createIdAllocator() });
    this.subscribe((t, ev, applied) => { if (applied && ev.type === "notify_status") this.statusLog.push([t.id, ev.status]); });
  }
  add(id: string, notify: NotifyLevel = "done", background = true): Task {
    const t = this.create({ command: "cmd", cwd: "/", hardTimeoutMs: null, bgTimeoutMs: null, notify, startInBackground: background });
    if (t.id !== id) throw new Error(`test expected ${id}, registry allocated ${t.id}`);
    return t;
  }
}
const exit = (code: number | null = 0, signal: string | null = null): TaskEvent => ({ type: "exit", code, signal, at: 0 });

const CONFIG: BgConfig["notify"] = { default: "done", delivery: "steer", wake: true, batchMs: 500 };
function setup(cfg: Partial<BgConfig["notify"]> = {}) {
  const clock = new FakeClock();
  const registry = new Reg(clock);
  const sink = new FakeNotificationSink();
  const policy = new NotificationPolicy({
    clock, config: { ...CONFIG, ...cfg }, registry, sink,
    summarize: (t) => ({ task: { id: t.id, state: t.state } as TaskSummary, tail: [] }),
  });
  registry.subscribe((t, ev, applied) => policy.onTaskEvent(t, ev, applied));
  const ids = () => sink.sent.map((s) => s.batch.items.map((i) => i.task.id));
  return { clock, registry, sink, policy, ids };
}

describe("levels versus outcomes", () => {
  const run = (level: NotifyLevel, end: (r: Reg) => void) => {
    const s = setup();
    s.registry.add("bg1", level);
    end(s.registry);
    s.clock.advance(500);
    return s;
  };
  const natural = (code: number | null, signal: string | null = null) => (r: Reg) => { r.dispatch("bg1", exit(code, signal)); };
  const killed = (cause: KillCause) => (r: Reg) => { r.dispatch("bg1", { type: "kill_requested", cause, at: 0 }); r.dispatch("bg1", exit(null, "SIGTERM")); };
  const hard = (r: Reg) => { r.dispatch("bg1", { type: "hard_timeout", at: 0 }); r.dispatch("bg1", exit(null, "SIGKILL")); };
  const spawnFail = (r: Reg) => { r.dispatch("bg1", { type: "spawn_failed", error: "ENOENT", at: 0 }); };

  const table: [string, NotifyLevel, (r: Reg) => void, boolean][] = [
    ["done: exit 0", "done", natural(0), true],
    ["done: exit 2", "done", natural(2), true],
    ["done: hard timeout", "done", hard, true],
    ["done: spawn failure", "done", spawnFail, true],
    ["done: bg_kill", "done", killed("bg_kill"), false],
    ["done: /bg kill", "done", killed("command"), false],
    ["done: shutdown", "done", killed("shutdown"), false],
    ["error: exit 0", "error", natural(0), false],
    ["error: exit 2", "error", natural(2), true],
    ["error: signal exit", "error", natural(null, "SIGSEGV"), true],
    ["error: hard timeout", "error", hard, true],
    ["error: spawn failure", "error", spawnFail, true],
    ["error: bg_kill", "error", killed("bg_kill"), false],
    ["off: exit 2", "off", natural(2), false],
    ["off: hard timeout", "off", hard, false],
  ];
  it.each(table)("%s -> notified: %s", (_n, level, end, notified) => {
    const s = run(level, end);
    expect(s.sink.sent).toHaveLength(notified ? 1 : 0);
    expect(s.registry.get("bg1")!.notifyStatus).toBe(notified ? "sent" : "suppressed");
  });
  it("a task that ends while still foreground is not notified and its status stays none", () => {
    const s = setup();
    s.registry.add("bg1", "done", false);
    s.registry.dispatch("bg1", exit(0));
    s.clock.advance(1000);
    expect(s.sink.sent).toEqual([]);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("none");
  });
});

describe("delivery options", () => {
  it.each([
    [{ delivery: "steer", wake: true }, { deliverAs: "steer", triggerTurn: true }],
    [{ delivery: "followUp", wake: false }, { deliverAs: "followUp", triggerTurn: false }],
    [{ delivery: "nextTurn", wake: true }, { deliverAs: "nextTurn", triggerTurn: true }],
  ] as const)("config %j -> %j", (cfg, opts) => {
    const s = setup(cfg);
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.policy.flush();
    expect(s.sink.sent[0].opts).toEqual(opts);
    expect(s.sink.sent[0].batch.redelivery).toBe(false);
  });
});

describe("batching", () => {
  it("coalesces completions inside batchMs into one message, sent at the window end", () => {
    const s = setup();
    for (const id of ["bg1", "bg2", "bg3"]) s.registry.add(id);
    s.registry.dispatch("bg1", exit(0));
    s.clock.advance(200);
    s.registry.dispatch("bg2", exit(1));
    s.clock.advance(299);
    expect(s.sink.sent).toEqual([]);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("pending");
    s.clock.advance(1);
    expect(s.ids()).toEqual([["bg1", "bg2"]]);
    // bg3 ends later: its own window and message
    s.registry.dispatch("bg3", exit(0));
    s.clock.advance(500);
    expect(s.ids()).toEqual([["bg1", "bg2"], ["bg3"]]);
  });
  it("flush() ends the window now and cancels the timer", () => {
    const s = setup();
    s.registry.add("bg1"); s.registry.add("bg2");
    s.registry.dispatch("bg1", exit(0)); s.registry.dispatch("bg2", exit(0));
    s.policy.flush();
    expect(s.ids()).toEqual([["bg1", "bg2"]]);
    expect(s.clock.pending()).toBe(0);
    s.policy.flush(); // nothing pending: no empty message
    expect(s.sink.sent).toHaveLength(1);
  });
  it("discard() drops the pending batch, cancels the timer and suppresses the tasks", () => {
    const s = setup();
    s.registry.add("bg1"); s.registry.add("bg2");
    s.registry.dispatch("bg1", exit(0)); s.registry.dispatch("bg2", exit(0));
    expect(s.clock.pending()).toBe(1);
    s.policy.discard();
    expect(s.clock.pending()).toBe(0);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("suppressed");
    s.policy.flush(); // negative control: nothing left to send
    s.clock.advance(1000);
    expect(s.sink.sent).toEqual([]);
  });
  it("discard() leaves already sent tasks alone", () => {
    const s = setup();
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.policy.flush();
    s.policy.discard();
    expect(s.registry.get("bg1")!.notifyStatus).toBe("sent");
  });
  it("batchMs 0 sends immediately", () => {
    const s = setup({ batchMs: 0 });
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    expect(s.ids()).toEqual([["bg1"]]);
  });
});

describe("once-only", () => {
  it("repeated terminal events (applied or not) and re-entrant status events notify once", () => {
    const s = setup();
    const t = s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.registry.dispatch("bg1", exit(0)); // absorbed by the registry (applied false)
    s.policy.onTaskEvent(t, exit(0), true); // forced duplicate applied=true
    s.policy.onTaskEvent(t, exit(0), true);
    s.clock.advance(500);
    s.policy.onTaskEvent(t, exit(0), true); // after it was sent
    s.clock.advance(5000);
    s.policy.flush();
    expect(s.sink.sent).toHaveLength(1);
    expect(s.registry.statusLog.map(([, st]) => st)).toEqual(["pending", "sent"]);
  });
  it("negative control: a non-terminal applied event does nothing", () => {
    const s = setup();
    const t = s.registry.add("bg1");
    s.policy.onTaskEvent(t, { type: "output", bytes: 1, at: 0 }, true);
    s.clock.advance(1000);
    expect(s.sink.sent).toEqual([]);
    expect(t.notifyStatus).toBe("none");
  });
});

describe("suppression by agent knowledge", () => {
  it("markAgentSaw while pending removes it from the batch; others still go out", () => {
    const s = setup();
    s.registry.add("bg1"); s.registry.add("bg2");
    s.registry.dispatch("bg1", exit(0)); s.registry.dispatch("bg2", exit(0));
    s.policy.markAgentSaw("bg1");
    s.clock.advance(500);
    expect(s.ids()).toEqual([["bg2"]]);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("suppressed");
  });
  it("markAgentSaw on the only pending task sends nothing and cancels the timer", () => {
    const s = setup();
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.policy.markAgentSaw("bg1");
    expect(s.clock.pending()).toBe(0);
    s.clock.advance(1000);
    expect(s.sink.sent).toEqual([]);
  });
  it("an ack arriving synchronously inside sink.send is kept (no duplicate after a later abort)", () => {
    const s = setup();
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    const send = s.sink.send.bind(s.sink);
    s.sink.send = (batch, opts) => {
      send(batch, opts);
      s.policy.markAcked(batch.items.map((i) => i.task.id));
    };
    s.policy.flush();
    expect(s.registry.get("bg1")!.notifyStatus).toBe("acked");
    s.policy.onAgentSettled(true);
    expect(s.sink.sent).toHaveLength(1);
  });
  it("markAgentSaw after sent marks acked (no redelivery later); on a running task is ignored", () => {
    const s = setup();
    s.registry.add("bg1"); s.registry.add("bg2");
    s.registry.dispatch("bg1", exit(0));
    s.policy.markAgentSaw("bg2");
    expect(s.registry.get("bg2")!.notifyStatus).toBe("none");
    s.policy.flush();
    s.policy.markAgentSaw("bg1");
    expect(s.registry.get("bg1")!.notifyStatus).toBe("acked");
    s.policy.onAgentSettled(true);
    expect(s.sink.sent).toHaveLength(1);
  });
  it("a task suppressed before its terminal event stays quiet (markAgentSaw then repeat event)", () => {
    const s = setup();
    const t = s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.policy.markAgentSaw("bg1");
    s.policy.onTaskEvent(t, exit(0), true);
    s.clock.advance(1000);
    expect(s.sink.sent).toEqual([]);
  });
});

describe("loss and single redelivery", () => {
  const sentOne = () => {
    const s = setup();
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.policy.flush();
    return s;
  };
  it("aborted settle with a sent, unacked task redelivers exactly once as nextTurn without waking", () => {
    const s = sentOne();
    s.policy.onAgentSettled(true);
    expect(s.sink.sent).toHaveLength(2);
    expect(s.sink.sent[1].batch).toMatchObject({ redelivery: true });
    expect(s.sink.sent[1].opts).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
    expect(s.ids()[1]).toEqual(["bg1"]);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("sent");
    expect(s.registry.get("bg1")!.notifyRedelivered).toBe(true);
    s.policy.onAgentSettled(true); // second loss: not retried
    s.policy.onAgentSettled(true);
    expect(s.sink.sent).toHaveLength(2);
  });
  it("a non-aborted settle redelivers nothing", () => {
    const s = sentOne();
    s.policy.onAgentSettled(false);
    expect(s.sink.sent).toHaveLength(1);
  });
  it("an acked task is not redelivered; only the unacked one is", () => {
    const s = setup();
    s.registry.add("bg1"); s.registry.add("bg2");
    s.registry.dispatch("bg1", exit(0)); s.registry.dispatch("bg2", exit(0));
    s.policy.flush();
    s.policy.markAcked(["bg1"]);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("acked");
    s.policy.onAgentSettled(true);
    expect(s.ids()[1]).toEqual(["bg2"]);
  });
  it("markAcked ignores ids that are unknown or not sent", () => {
    const s = setup();
    s.registry.add("bg1");
    s.policy.markAcked(["bg1", "nope"]);
    expect(s.registry.get("bg1")!.notifyStatus).toBe("none");
  });
  it("a pending (not yet sent) task is not redelivered by an abort", () => {
    const s = setup();
    s.registry.add("bg1");
    s.registry.dispatch("bg1", exit(0));
    s.policy.onAgentSettled(true);
    expect(s.sink.sent).toEqual([]);
    s.clock.advance(500);
    expect(s.sink.sent).toHaveLength(1);
  });
});

describe("isErrorOutcome", () => {
  const t = (state: string, exitCode: number | null = 0, signal: string | null = null) => ({ state, exitCode, signal }) as never;
  it("is false only for a clean exit", () => {
    expect(isErrorOutcome(t("exited"))).toBe(false);
    expect(isErrorOutcome(t("exited", 2))).toBe(true);
    expect(isErrorOutcome(t("exited", null, "SIGSEGV"))).toBe(true);
    expect(isErrorOutcome(t("killed", null, "SIGTERM"))).toBe(true);
    expect(isErrorOutcome(t("timed_out"))).toBe(true);
    expect(isErrorOutcome(t("spawn_failed", null))).toBe(true);
  });
});
