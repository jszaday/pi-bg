// S6: Pi awaits an async session_shutdown on every path and never cleans an extension's tasks itself, so pi-bg must leave no process group behind.
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createLive, skipReason, sleep, until, type Live } from "../support/harness.js";

const skip = skipReason("shutdown");
let live: Live | undefined;
afterEach(async () => { await live?.cleanup(); live = undefined; });

// "[s]" keeps pgrep from matching its own command line.
const procs = (n: number): number => {
  try {
    return execFileSync("pgrep", ["-f", `[s]leep ${n}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};

describe.skipIf(!!skip)("live shutdown (real pi-bg, S6 matrix: session_shutdown reasons)", () => {
  for (const [i, reason] of (["quit", "reload", "new", "resume"] as const).entries()) {
    const n = 3141 + i;
    it(`session_shutdown(${reason}) leaves no task process, including a grandchild`, async () => {
      live = await createLive();
      // a shell with a background grandchild, both in the task's process group
      live.faux.setResponses([
        live.toolTurn(live.call("bash", { command: `sleep ${n} & sleep ${n}`, bg_timeout: 1 }, "b1")),
        live.text("started"),
      ]);
      await live.session.prompt("go");
      await until(() => procs(n) >= 2, 5000, "task and grandchild to be running");
      expect(live.toolResults().find((x) => x.id === "b1")!.text).toMatch(/bg1/);
      const t0 = Date.now();
      await live.session.extensionRunner.emit({ type: "session_shutdown", reason } as never);
      expect(procs(n)).toBe(0); // gone as soon as the awaited handler returns
      expect(Date.now() - t0).toBeLessThan(6000);
      await sleep(200);
      expect(procs(n)).toBe(0);
    }, 40_000);
  }

  it("negative control: before shutdown both processes are alive", async () => {
    live = await createLive();
    live.faux.setResponses([live.toolTurn(live.call("bash", { command: "sleep 3150 & sleep 3150", bg_timeout: 1 }, "b1")), live.text("ok")]);
    await live.session.prompt("go");
    await until(() => procs(3150) >= 2, 5000, "processes running");
    expect(procs(3150)).toBeGreaterThanOrEqual(2);
  }, 40_000);
});
