import { describe, expect, it } from "vitest";
import { createMonitorSink, createNotificationSink, installNotifyHandlers } from "../../src/pi/notify.js";
import { MONITOR_TYPE, NOTIFICATION_TYPE, type MonitorDetails, type NotificationDetails } from "../../src/pi/runtime.js";
import { FakePi } from "../fakes/index.js";
import { w8Services, w8Task } from "./w8-helpers.js";

function finish(h: ReturnType<typeof w8Services>, id: string, code = 0) {
  h.registry.dispatch(id, { type: "exit", code, signal: null, at: h.clock.now() });
}

function wired(config: Parameters<typeof w8Services>[0] = {}) {
  const pi = new FakePi();
  const h = w8Services({ ...config, sink: createNotificationSink(pi.asExtensionAPI()) });
  installNotifyHandlers(pi.asExtensionAPI(), h.notify);
  return { pi, h };
}

describe("notification sink options per mode", () => {
  const cases: [string, "steer" | "followUp" | "nextTurn", boolean, boolean][] = [
    ["steer + wake", "steer", true, true],
    ["steer, wake off", "steer", false, false],
    ["followUp + wake", "followUp", true, true],
    ["followUp, wake off", "followUp", false, false],
    ["nextTurn never triggers a turn (S5)", "nextTurn", true, false],
  ];
  for (const [name, delivery, wake, expected] of cases) {
    it(name, () => {
      const { pi, h } = wired({ config: { notify: { default: "done", delivery, wake, batchMs: 0 } } });
      const t = w8Task(h);
      finish(h, t.id);
      expect(pi.messages).toHaveLength(1);
      const m = pi.messages[0];
      expect(m.opts).toEqual({ deliverAs: delivery, triggerTurn: expected });
      const msg = m.msg as { customType: string; display: boolean; content: string; details: NotificationDetails };
      expect(msg.customType).toBe(NOTIFICATION_TYPE);
      expect(msg.display).toBe(true);
      expect(msg.content).toContain(t.id);
      expect(msg.details.taskIds).toEqual([t.id]);
    });
  }

  it("is once-only: repeated terminal events send one message", () => {
    const { pi, h } = wired({ config: { notify: { default: "done", delivery: "steer", wake: true, batchMs: 0 } } });
    const t = w8Task(h);
    finish(h, t.id);
    finish(h, t.id);
    h.notify.flush();
    expect(pi.messages).toHaveLength(1);
  });

  it("batches tasks finishing inside batchMs into one message", () => {
    const { pi, h } = wired();
    const a = w8Task(h);
    const b = w8Task(h);
    finish(h, a.id);
    finish(h, b.id);
    h.clock.advance(500);
    expect(pi.messages).toHaveLength(1);
    expect((pi.messages[0].msg as { details: NotificationDetails }).details.taskIds).toEqual([a.id, b.id]);
  });

  it("reports a failing send through onError without throwing", () => {
    const pi = new FakePi();
    pi.sendMessage = () => { throw new Error("stale"); };
    const errs: unknown[] = [];
    const sink = createNotificationSink(pi.asExtensionAPI(), (e) => errs.push(e));
    expect(() => sink.send({ items: [], redelivery: false }, { deliverAs: "steer", triggerTurn: true })).not.toThrow();
    expect(errs).toHaveLength(1);
  });
});

describe("ack and loss wiring", () => {
  const customEnd = (ids: string[]) => ({ type: "message_end", message: { role: "custom", customType: NOTIFICATION_TYPE, details: { taskIds: ids } } });

  it("custom message_end acks; an aborted settle then redelivers nothing", async () => {
    const { pi, h } = wired({ config: { notify: { default: "done", delivery: "steer", wake: true, batchMs: 0 } } });
    const t = w8Task(h);
    finish(h, t.id);
    expect(h.registry.get(t.id)?.notifyStatus).toBe("sent");
    await pi.emit("message_end", customEnd([t.id]));
    expect(h.registry.get(t.id)?.notifyStatus).toBe("acked");
    await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
    expect(pi.messages).toHaveLength(1);
  });

  it("ignores other messages (negative control)", async () => {
    const { pi, h } = wired({ config: { notify: { default: "done", delivery: "steer", wake: true, batchMs: 0 } } });
    const t = w8Task(h);
    finish(h, t.id);
    await pi.emit("message_end", { type: "message_end", message: { role: "user" } });
    await pi.emit("message_end", { type: "message_end", message: { role: "custom", customType: "other", details: { taskIds: [t.id] } } });
    expect(h.registry.get(t.id)?.notifyStatus).toBe("sent");
  });

  it("an aborted settle with no ack redelivers once as nextTurn; a second abort does not", async () => {
    const { pi, h } = wired({ config: { notify: { default: "done", delivery: "steer", wake: true, batchMs: 0 } } });
    const t = w8Task(h);
    finish(h, t.id);
    await pi.emit("agent_settled", { type: "agent_settled", aborted: false });
    expect(pi.messages).toHaveLength(1);
    await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
    expect(pi.messages).toHaveLength(2);
    expect(pi.messages[1].opts).toEqual({ deliverAs: "nextTurn", triggerTurn: false });
    expect((pi.messages[1].msg as { details: NotificationDetails }).details.batch.redelivery).toBe(true);
    await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
    expect(pi.messages).toHaveLength(2);
  });
});

describe("monitor sink", () => {
  const batch = { id: "bg1", lines: ["ready"], omitted: 0, maxNotifications: 10 };
  const cases: [string, "steer" | "followUp" | "nextTurn", boolean, boolean][] = [
    ["steer + wake", "steer", true, true],
    ["followUp, wake off", "followUp", false, false],
    ["nextTurn never triggers a turn", "nextTurn", true, false],
  ];
  for (const [name, deliverAs, triggerTurn, expected] of cases) {
    it(`sends pi-bg:monitor, ${name}`, () => {
      const pi = new FakePi();
      createMonitorSink(pi.asExtensionAPI()).send(batch, { deliverAs, triggerTurn });
      expect(pi.messages).toHaveLength(1);
      expect(pi.messages[0].opts).toEqual({ deliverAs, triggerTurn: expected });
      const msg = pi.messages[0].msg as { customType: string; display: boolean; content: string; details: MonitorDetails };
      expect(msg.customType).toBe(MONITOR_TYPE);
      expect(msg.customType).not.toBe(NOTIFICATION_TYPE);
      expect(msg.display).toBe(true);
      expect(msg.content).toContain("Monitor bg1: 1 new line:");
      expect(msg.details.batch).toEqual(batch);
    });
  }

  it("reports a failing send through onError without throwing", () => {
    const pi = new FakePi();
    pi.sendMessage = () => { throw new Error("stale"); };
    const errs: unknown[] = [];
    expect(() => createMonitorSink(pi.asExtensionAPI(), (e) => errs.push(e)).send(batch, { deliverAs: "steer", triggerTurn: true })).not.toThrow();
    expect(errs).toHaveLength(1);
  });

  it("the last monitor lines are sent before the task-end notification", () => {
    const pi = new FakePi();
    const api = pi.asExtensionAPI();
    const h = w8Services({
      config: { notify: { default: "done", delivery: "steer", wake: true, batchMs: 0 } },
      sink: createNotificationSink(api),
      monitorSink: createMonitorSink(api),
    });
    const t = w8Task(h);
    h.monitors.start(t.id, { maxNotifications: 10 });
    h.monitors.onOutput(t.id, new TextEncoder().encode("final words"));
    finish(h, t.id);
    expect(pi.messages.map((m) => (m.msg as { customType: string }).customType)).toEqual([MONITOR_TYPE, NOTIFICATION_TYPE]);
    expect((pi.messages[0].msg as { content: string }).content).toContain("final words");
  });

  it("monitor messages are not acked or redelivered", async () => {
    const pi = new FakePi();
    const api = pi.asExtensionAPI();
    const h = w8Services({ monitorSink: createMonitorSink(api) });
    installNotifyHandlers(api, h.notify);
    const t = w8Task(h);
    h.monitors.start(t.id, { maxNotifications: 10 });
    h.monitors.onOutput(t.id, new TextEncoder().encode("x\n"));
    h.clock.advance(1000);
    await pi.emit("message_end", { type: "message_end", message: { role: "custom", customType: MONITOR_TYPE, details: { batch: { id: t.id } } } });
    await pi.emit("agent_settled", { type: "agent_settled", aborted: true });
    expect(pi.messages).toHaveLength(1);
  });
});
