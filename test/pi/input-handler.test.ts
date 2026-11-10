import { describe, expect, it } from "vitest";
import { installInputHandler } from "../../src/pi/input-handler.js";
import { FakePi } from "../fakes/index.js";
import { w8Services, w8Task } from "./w8-helpers.js";

async function fire(pi: FakePi, streamingBehavior: unknown, source = "interactive") {
  return pi.emit("input", { type: "input", text: "hi", source, streamingBehavior });
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
    expect(await fire(pi, "steer")).toEqual([{ action: "continue" }]); // no active wait: remembered, not signalled
    expect((await h.s.waits.wait({ ids: [t.id], mode: "any", timeoutMs: 100 }, undefined)).reason).toBe("user_message"); // #19
    await pi.emit("turn_start", { type: "turn_start" });
    const p = h.s.waits.wait({ ids: [t.id], mode: "any", timeoutMs: 100 }, undefined);
    expect(await fire(pi, undefined)).toEqual([{ action: "continue" }]); // idle input with a wait active
    expect(calls).toBe(0);
    h.clock.advance(100);
    expect((await p).reason).toBe("timeout");
  });

  describe("a message queued before the wait starts (#19)", () => {
    function setup() {
      const h = w8Services();
      const t = w8Task(h);
      const pi = new FakePi();
      installInputHandler(pi.asExtensionAPI(), h.s);
      const wait = () => h.s.waits.wait({ ids: [t.id], mode: "any", timeoutMs: 60_000 }, undefined);
      return { h, pi, wait };
    }

    it("ends a later wait at once with user_message, for steer and followUp", async () => {
      for (const mode of ["steer", "followUp"]) {
        const { pi, wait } = setup();
        await fire(pi, mode); // no wait active yet
        expect(await wait()).toMatchObject({ reason: "user_message", waitedMs: 0 });
      }
    });

    it("keeps ending waits until turn_start, then waits normally again", async () => {
      const { h, pi, wait } = setup();
      await fire(pi, "steer");
      expect((await wait()).reason).toBe("user_message");
      expect((await wait()).reason).toBe("user_message"); // same tool batch
      await pi.emit("turn_start", { type: "turn_start" });
      const p = wait();
      expect(h.clock.pending()).toBe(1);
      h.clock.advance(60_000);
      expect((await p).reason).toBe("timeout");
    });

    it("ignores idle input and extension-sourced messages (negative controls)", async () => {
      const { h, pi, wait } = setup();
      await fire(pi, undefined);
      await fire(pi, "steer", "extension");
      const p = wait();
      expect(h.clock.pending()).toBe(1);
      h.clock.advance(60_000);
      expect((await p).reason).toBe("timeout");
    });
  });
});
