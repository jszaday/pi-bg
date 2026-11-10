// bg_monitor through the real composition root (src/index.ts): tasks adopted across /reload and the order of
// monitor and notification messages at task end. The "previous instance" is a w6b environment whose startTask
// wired the output sink, as the real extension does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSpec } from "../../src/contract.js";
import piBg from "../../src/index.js";
import { MONITOR_BATCH_MS } from "../../src/core/monitor-policy.js";
import { keepForReload, takeKept } from "../../src/pi/reload-slot.js";
import { MONITOR_TYPE, NOTIFICATION_TYPE } from "../../src/pi/runtime.js";
import { startTask } from "../../src/pi/start-task.js";
import { FakePi } from "../fakes/index.js";
import { w6bEnv, w6bFlush } from "./w6b-helpers.js";
import { w8Ctx } from "./w8-helpers.js";

const spec: TaskSpec = { command: "srv", cwd: "/tmp", hardTimeoutMs: null, bgTimeoutMs: null, notify: "done", startInBackground: true };
const savedEnv = process.env.PI_CODING_AGENT_DIR;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "monitor-wiring-"));
  mkdirSync(join(root, "agent"));
  writeFileSync(join(root, "agent", "pi-bg.json"), JSON.stringify({ notify: { batchMs: 0 } })); // task-end notification at once
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
  takeKept();
  if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

/** A task started by a previous instance and handed over; the new instance is created and started. */
async function adopted(steps: Parameters<ReturnType<typeof w6bEnv>["runner"]["script"]>[0]) {
  const old = w6bEnv();
  old.runner.script(steps);
  expect(startTask(old.s, spec).ok).toBe(true);
  keepForReload({ registry: old.s.registry, runtime: old.s.runtime, reseed: () => {}, release: () => {} });
  const pi = new FakePi();
  piBg(pi.asExtensionAPI());
  await pi.emit("session_start", { type: "session_start", reason: "reload" }, w8Ctx(pi, { isProjectTrusted: () => false }));
  const types = () => pi.messages.map((m) => (m.msg as { customType: string }).customType);
  const monitorText = () => pi.messages.filter((m) => (m.msg as { customType: string }).customType === MONITOR_TYPE).map((m) => (m.msg as { content: string }).content).join("\n");
  return { old, pi, types, monitorText };
}

describe("bg_monitor on a task adopted across /reload", () => {
  it("receives the adopted task's output in the new instance", async () => {
    const x = await adopted([{ at: 10, chunk: "early\n" }, { at: 50, chunk: "ready\n" }]);
    await x.pi.callTool("bg_monitor", { id: "bg1", grep: "ready" });
    x.old.clock.advance(50);
    vi.advanceTimersByTime(MONITOR_BATCH_MS);
    expect(x.types()).toEqual([MONITOR_TYPE]);
    expect(x.monitorText()).toContain("ready");
    expect(x.monitorText()).not.toContain("early");
  });
});

describe("monitor and notification order at task end (real composition root)", () => {
  it("sends the last monitor lines before the task-end notification", async () => {
    const x = await adopted([{ at: 10, chunk: "last words" }, { at: 20, exit: { code: 0, signal: null } }]);
    await x.pi.callTool("bg_monitor", { id: "bg1" });
    x.old.clock.advance(20);
    await w6bFlush();
    expect(x.types()).toEqual([MONITOR_TYPE, NOTIFICATION_TYPE]);
    expect(x.monitorText()).toContain("last words");
  });
});
