// Issue #18: a job started with `&` outlives its task (the shell exits, the job stays in the task's process group).
// Real own-spawn runner and real processes; every pid asserted on is a positive pid we read back (alive(0) is always true).
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnSpawnRunner, createReaper, piShellEnv, resolveShell } from "../../src/adapters/index.js";
import type { TaskSpec } from "../../src/contract.js";
import { killAll } from "../../src/pi/lifecycle.js";
import { startTask } from "../../src/pi/start-task.js";
import { alive, cleanup, readPid, tmp, waitFor } from "../adapters/helpers.js";
import { w6bEnv, w6bFlush } from "./w6b-helpers.js";

const shell = resolveShell();
if ("error" in shell) throw new Error(shell.error);
const runner = createOwnSpawnRunner({ ...shell, env: () => piShellEnv(), termGraceMs: 300 });

const cleanupPids: number[] = []; // groups this test started: the only things it may signal
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of cleanupPids.splice(0)) {
    try { process.kill(-p, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(p, "SIGKILL"); } catch { /* gone */ }
  }
  cleanup();
});

const spec = (command: string, cwd: string): TaskSpec => ({
  command,
  cwd,
  hardTimeoutMs: null,
  bgTimeoutMs: null,
  notify: "done",
  startInBackground: true,
});

/** Starts `sleep 300 & echo $! > gc`, waits until the task is `exited` while the job lives. */
async function exitedWithLeftoverJob(e: ReturnType<typeof w6bEnv>) {
  const d = tmp();
  const r = startTask(e.s, spec(`sleep 300 & echo $! > ${d}/gc`, d));
  if (!r.ok) throw new Error(r.message);
  const pgid = r.handle.pid!;
  expect(pgid).toBeGreaterThan(0);
  const gc = await readPid(`${d}/gc`);
  cleanupPids.push(pgid, gc);
  expect(gc).toBeGreaterThan(0);
  expect(await waitFor(() => e.s.registry.get(r.task.id)?.state === "exited", 3000)).toBe(true);
  await w6bFlush();
  expect(alive(gc)).toBe(true); // the premise of the issue: exited task, live job
  return { pgid, gc, id: r.task.id };
}

describe("a background job left in an exited task's process group (#18)", () => {
  it("is killed by session shutdown (killAll)", async () => {
    const e = w6bEnv({ runner });
    const { gc } = await exitedWithLeftoverJob(e);
    await killAll(e.s);
    expect(await waitFor(() => !alive(gc), 2000)).toBe(true);
  }, 15_000);

  it("negative control: without shutdown the job keeps running and the task stays exited", async () => {
    const e = w6bEnv({ runner });
    const { gc, id } = await exitedWithLeftoverJob(e);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(gc)).toBe(true);
    expect(e.s.registry.get(id)?.state).toBe("exited");
  }, 15_000);

  it("is not signalled by shutdown once its group was seen empty (pgid reuse guard)", async () => {
    const e = w6bEnv({ runner });
    const { pgid, gc } = await exitedWithLeftoverJob(e);
    process.kill(gc, "SIGKILL"); // the job we started ends on its own; the group is now empty
    expect(await waitFor(() => !alive(gc), 2000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500)); // the runner notices the empty group
    const real = process.kill.bind(process);
    const sent: [number, string | number | undefined][] = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, sig?: string | number) => {
      if (pid === -pgid) {
        sent.push([pid, sig]);
        return true; // pretend an unrelated group now owns this id
      }
      return real(pid, sig as never);
    }) as typeof process.kill);
    await killAll(e.s);
    expect(sent.filter(([, s]) => s !== 0 && s !== undefined)).toEqual([]);
  }, 15_000);

  it("start-task keeps the reaper watching after the task exits, so a Pi crash still cleans the group", async () => {
    const owner = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    owner.unref();
    cleanupPids.push(owner.pid!);
    const e = w6bEnv({ runner });
    e.s.reaper = createReaper({ ownerPid: owner.pid! });
    const { gc } = await exitedWithLeftoverJob(e);
    await new Promise((r) => setTimeout(r, 1300)); // a full poll cycle with the owner alive: untouched
    expect(alive(gc)).toBe(true);
    process.kill(owner.pid!, "SIGKILL"); // stand-in for Pi crashing
    expect(await waitFor(() => !alive(gc), 3000)).toBe(true);
  }, 15_000);
});
