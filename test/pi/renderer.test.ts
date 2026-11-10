import { describe, expect, it } from "vitest";
import type { NotificationBatch, TaskSummary } from "../../src/contract.js";
import { monitorText, notificationText } from "../../src/core/format.js";
import { registerMonitorRenderer, registerNotificationRenderer } from "../../src/pi/renderer.js";
import { MONITOR_TYPE, NOTIFICATION_TYPE, type MonitorDetails, type NotificationDetails } from "../../src/pi/runtime.js";
import { FakePi } from "../fakes/index.js";

// Theme stand-in that tags the colour so tests can see which one was chosen.
const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>` };
type Render = (m: unknown, o: { expanded: boolean; outputPad: number }, t: unknown) => { render(w: number): string[] } | undefined;

const summary = (over: Partial<TaskSummary> = {}): TaskSummary => ({
  id: "bg1", command: "make", state: "exited", startedAt: "2024-01-01T00:00:00.000Z", runtimeS: 12, exitCode: 0,
  totalBytes: 10, notify: "done", notified: false, logDegraded: false, ...over,
});
const one: NotificationBatch = { items: [{ task: summary({ label: "build" }), tail: ["done ok"] }], redelivery: false };
const many: NotificationBatch = {
  items: [
    { task: summary({ label: "build" }), tail: ["done ok"] },
    { task: summary({ id: "bg2", exitCode: 2 }), tail: ["boom"] },
  ],
  redelivery: false,
};

function setup() {
  const pi = new FakePi();
  registerNotificationRenderer(pi.asExtensionAPI());
  const render = pi.renderers.get(NOTIFICATION_TYPE) as Render;
  const text = (message: object, expanded = false) =>
    render({ role: "custom", customType: NOTIFICATION_TYPE, display: true, timestamp: 0, ...message }, { expanded, outputPad: 0 }, theme)!
      .render(200)
      .map((l) => l.trimEnd())
      .join("\n");
  return { pi, render, text };
}

const details = (batch: NotificationBatch): NotificationDetails => ({ taskIds: batch.items.map((i) => i.task.id), batch });

describe("notification renderer", () => {
  it("registers for pi-bg:task", () => {
    expect(setup().pi.renderers.has("pi-bg:task")).toBe(true);
  });

  it("renders one task compactly with the success colour", () => {
    const out = setup().text({ content: "x", details: details(one) });
    expect(out).toContain("<success>bg1 (build) exited with code 0 after 12s.</success>");
    expect(out).not.toContain("done ok");
  });

  it("renders a batch with one line per task and the error colour for a failure", () => {
    const out = setup().text({ content: "x", details: details(many) });
    expect(out).toContain("<success>bg1 (build) exited with code 0 after 12s.</success>");
    expect(out).toContain("<error>bg2 exited with code 2 after 12s.</error>");
    expect(out.split("\n")).toHaveLength(2);
  });

  it("marks a redelivery", () => {
    expect(setup().text({ content: "x", details: details({ ...one, redelivery: true }) })).toContain("sent again");
  });

  it("expanded shows the full notification text", () => {
    const out = setup().text({ content: "x", details: details(many) }, true);
    for (const line of notificationText(many).split("\n")) expect(out).toContain(line.trimEnd());
  });

  it("falls back to message content when details are missing or malformed", () => {
    const { text } = setup();
    expect(text({ content: "plain content" })).toContain("plain content");
    expect(text({ content: "plain content", details: { taskIds: [] } })).toContain("plain content");
    expect(text({ content: [{ type: "text", text: "blocks" }], details: { batch: { items: [] } } })).toContain("blocks");
  });
});

describe("monitor renderer", () => {
  const batch = { id: "bg3", lines: ["first", "ready on :8080"], omitted: 0, maxNotifications: 10 };
  const render = (message: object, expanded = false) => {
    const pi = new FakePi();
    registerMonitorRenderer(pi.asExtensionAPI());
    expect(pi.renderers.has("pi-bg:monitor")).toBe(true);
    const r = pi.renderers.get(MONITOR_TYPE) as Render;
    return r({ role: "custom", customType: MONITOR_TYPE, display: true, timestamp: 0, ...message }, { expanded, outputPad: 0 }, theme)!
      .render(200)
      .map((l) => l.trimEnd())
      .join("\n");
  };
  const details = (b: MonitorDetails["batch"]): MonitorDetails => ({ batch: b });

  it("collapsed shows the header and the last line only", () => {
    const out = render({ content: "x", details: details(batch) });
    expect(out).toBe(" <muted>Monitor bg3: 2 new lines, last: ready on :8080</muted>");
    expect(out).not.toContain("first");
  });

  it("expanded shows the full message text", () => {
    const out = render({ content: "x", details: details({ ...batch, stopped: "task_ended" }) }, true);
    for (const line of monitorText({ ...batch, stopped: "task_ended" }).split("\n")) expect(out).toContain(line.trimEnd());
  });

  it("falls back to message content when details are missing or malformed", () => {
    expect(render({ content: "plain" })).toContain("plain");
    expect(render({ content: "plain", details: { batch: { lines: [] } } })).toContain("plain");
  });
});
