import { describe, expect, it } from "vitest";
import { createNotificationSink, installNotifyHandlers } from "../../src/pi/notify.js";
import { NOTIFICATION_TYPE, type NotificationDetails } from "../../src/pi/runtime.js";
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
