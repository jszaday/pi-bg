// Shutdown with the real killTasks (lifecycle.test.ts mocks it).
import { describe, expect, it } from "vitest";
import { killAll } from "../../src/pi/lifecycle.js";
import { makeHarness } from "./w6a-services.js";

describe("killAll with the real killTasks", () => {
  it("terminates running tasks with cause shutdown, stays quiet about them, and reports nothing on success", async () => {
    const h = makeHarness();
    h.start("sleep 100");
    h.start("sleep 200");
    const groups: number[] = [];
    await killAll(h.s, (g) => groups.push(g));
    await h.flush();
    expect(h.runner.kills[0]).toBe("term");
    for (const id of ["bg1", "bg2"]) expect(h.s.registry.get(id)).toMatchObject({ state: "killed", killCause: "shutdown" });
    expect(h.sink.sent).toHaveLength(0); // shutdown kills are suppressed
    expect(h.ui.msgs).toEqual([]);
  });
});
