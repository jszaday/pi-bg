import type { KillCause, ProcessHandle, TaskId } from "../contract.js";
import { type KillResult, failure } from "../core/format.js";
import { isTerminal } from "../core/task.js";
import { killBoundMs, type Services } from "./runtime.js";

/**
 * Shared by bg_kill, /bg kill and shutdown. One `term` per running task; the runner owns the escalation to
 * SIGKILL. The wait for the exit is bounded (killBoundMs of termGraceMs) on the injected clock. The exit handler
 * does not delete `s.runtime` entries: the ring tail serves finished-task tails and degraded logs.
 * TODO(runtime-gc) P3: memory is bounded per task by the ring size but unbounded in task count; evict old finished entries if sessions grow long.
 */
export async function killTasks(s: Services, which: TaskId[] | "all", cause: KillCause): Promise<KillResult> {
  const result: KillResult = { killed: [], alreadyFinished: [], failed: [] };
  const ids = which === "all" ? s.registry.running().map((t) => t.id) : [...new Set(which)];
  const known = (): string =>
    s.registry
      .list()
      .map((t) => t.id)
      .join(", ") || "none";
  const pending: Promise<void>[] = [];

  for (const id of ids) {
    const task = s.registry.get(id);
    if (!task) {
      const text = failure(s.registry.isStale(id) ? "stale_id" : "unknown_id", { id, known: known() });
      result.failed.push({ id, error: text });
      continue;
    }
    if (isTerminal(task)) {
      result.alreadyFinished.push(id);
      continue;
    }
    const rt = s.runtime.get(id);
    const handle = rt?.handle;
    if (!handle) {
      result.failed.push({
        id,
        error: failure("kill_no_handle", { id, ...(task.pid !== undefined && { pid: task.pid }) }),
      });
      continue;
    }
    s.registry.dispatch(id, { type: "kill_requested", cause, at: s.clock.now() });
    for (const timer of rt.timers.splice(0)) s.clock.clearTimeout(timer);
    handle.kill("term");
    pending.push(waitForExit(s, id, handle, result));
  }
  await Promise.all(pending);
  return result;
}

async function waitForExit(
  s: Services,
  id: TaskId,
  handle: ProcessHandle,
  result: KillResult,
): Promise<void> {
  const boundMs = killBoundMs(s.config().kill.termGraceMs);
  let timer: unknown;
  const timedOut = new Promise<false>((resolve) => {
    timer = s.clock.setTimeout(() => resolve(false), boundMs);
  });
  const exited = await Promise.race([handle.exited.then(() => true as const), timedOut]);
  s.clock.clearTimeout(timer);
  if (exited) {
    result.killed.push(id);
    return;
  }
  const pid = handle.pid ?? s.registry.get(id)?.pid;
  result.failed.push({
    id,
    error: failure("kill_not_exited", {
      id,
      seconds: Math.round(boundMs / 1000),
      ...(pid !== undefined && { pid }),
    }),
  });
}
