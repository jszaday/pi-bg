import { describe, expect, it } from "vitest";
import { installInputHandler } from "../../src/pi/input-handler.js";
import { FakePi } from "../fakes/index.js";
import { w8Services, w8Task } from "./w8-helpers.js";

async function fire(pi: FakePi, streamingBehavior: unknown) {
  return pi.emit("input", { type: "input", text: "hi", source: "interactive", streamingBehavior });
}

describe("input handler", () => {
  it("releases an active wait for steer and followUp, and always continues", async () => {
    for (const mode of ["steer", "followUp"]) {
      const h = w8Services();
      const t = w8Task(h);
      const pi = new FakePi();
      installInputHandler(pi.asExtensionAPI(), h.s);
      const p = h.s.waits.wait({ ids: [t.id], mode: "any", timeoutMs: 60_000 }, undefined);
      pi.pendingMessages = 1;
      expect(await fire(pi, mode)).toEqual([{ action: "continue" }]);
      h.clock.advance(60);
      expect((await p).reason).toBe("user_message");
    }
  });

  it("does not signal when idle (no streamingBehavior) or when no wait is active, still continues", async () => {
    const h = w8Services();
    const t = w8Task(h);
    const pi = new FakePi();
    installInputHandler(pi.asExtensionAPI(), h.s);
    let calls = 0;
    const orig = h.s.waits.onUserMessage.bind(h.s.waits);
    h.s.waits.onUserMessage = () => { calls++; orig(); };
    expect(await fire(pi, undefined)).toEqual([{ action: "continue" }]);
    expect(await fire(pi, "steer")).toEqual([{ action: "continue" }]); // no active wait
    const p = h.s.waits.wait({ ids: [t.id], mode: "any", timeoutMs: 100 }, undefined);
    expect(await fire(pi, undefined)).toEqual([{ action: "continue" }]); // idle input with a wait active
    expect(calls).toBe(0);
    h.clock.advance(100);
    expect((await p).reason).toBe("timeout");
  });
});
