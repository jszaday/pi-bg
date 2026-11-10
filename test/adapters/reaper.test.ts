import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createReaper } from "../../src/adapters/index.js";
import { alive, cleanup, readPid, tmp, waitFor } from "./helpers.js";

const spawned: number[] = []; // pids/groups this test spawned: the only things it may signal
afterEach(() => {
  for (const p of spawned.splice(0)) {
    try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
  }
  cleanup();
});

function spawnOwner(): number {
  const o = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  o.unref();
  spawned.push(o.pid!);
  return o.pid!;
}
async function spawnGroup(): Promise<{ leader: number; gc: number }> {
  const d = tmp();
  const g = spawn("/bin/sh", ["-c", `sleep 60 & echo $! > ${d}/gc; wait`], { detached: true, stdio: "ignore" });
  g.unref();
  spawned.push(g.pid!);
  return { leader: g.pid!, gc: await readPid(`${d}/gc`) };
}

describe("reaper (S6 criterion: group gone within 2 s of owner SIGKILL; no reaper outlives its work)", () => {
  it("kills the group within 2 s after the owner is SIGKILLed, and the watcher exits", async () => {
    const owner = spawnOwner();
    const { leader, gc } = await spawnGroup();
    const r = createReaper({ ownerPid: owner })!;
    r.watch(leader, leader);
    const w = r.watcherPid!(leader)!;
    expect(alive(w)).toBe(true);
    await new Promise((res) => setTimeout(res, 1300)); // owner alive: group must survive a full poll cycle
    expect(alive(gc)).toBe(true);
    const t0 = Date.now();
    process.kill(owner, "SIGKILL"); // a pid we spawned
    expect(await waitFor(() => !alive(gc), 2500)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(await waitFor(() => !alive(w), 2000)).toBe(true);
  }, 15_000);

  it("negative control: with the owner alive the group is never touched", async () => {
    const owner = spawnOwner();
    const { leader, gc } = await spawnGroup();
    createReaper({ ownerPid: owner })!.watch(leader, leader);
    await new Promise((res) => setTimeout(res, 2200));
    expect(alive(gc)).toBe(true);
  }, 10_000);

  it("a watcher exits by itself when the group is already empty (no signal to a reusable id)", async () => {
    const owner = spawnOwner();
    const { leader, gc } = await spawnGroup();
    const r = createReaper({ ownerPid: owner })!;
    r.watch(leader, leader);
    const w = r.watcherPid!(leader)!;
    process.kill(-leader, "SIGKILL"); // group we spawned
    expect(await waitFor(() => !alive(gc), 2000)).toBe(true);
    expect(await waitFor(() => !alive(w), 2500)).toBe(true);
  }, 10_000);

  it("unwatch stops the watcher", async () => {
    const owner = spawnOwner();
    const { leader } = await spawnGroup();
    const r = createReaper({ ownerPid: owner })!;
    r.watch(leader, leader);
    const w = r.watcherPid!(leader)!;
    r.unwatch(leader);
    expect(await waitFor(() => !alive(w), 1500)).toBe(true);
    expect(r.watcherPid!(leader)).toBeUndefined();
  });
});
