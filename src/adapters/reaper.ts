import { spawn } from "node:child_process";

/**
 * Orphan reaper (DESIGN section 12; P2). One tiny detached POSIX `sh` watcher per task group: polls the owner (the current Pi process)
 * and, once it is gone while the group still has members, SIGKILLs the group. It exits as soon as the group is empty
 * (so a recycled group id is never signalled) or when `unwatch` kills it. Lag is up to one poll interval (1 s).
 * `watch(pid, pgid)`: `pid` is the task leader (used only to identify the watcher); the owner watched is `process.pid`.
 */
// Note: dash's builtin kill rejects `--`, so negative pids are passed as "-$pgid" directly (`kill -s KILL -- -$pgid` also works in dash). Measured with a 0.2 s poll: the group was gone 216 to 221 ms after a SIGKILL of Pi.
export const REAPER_SCRIPT = [
  'owner=$1; pgid=$2',
  'while :; do',
  '  if ! kill -0 "-$pgid" 2>/dev/null; then exit 0; fi',      // group empty: nothing to reap, never signal again
  '  if ! kill -0 "$owner" 2>/dev/null; then kill -KILL "-$pgid" 2>/dev/null; exit 0; fi',
  '  sleep 1',
  'done',
].join("\n");

export interface Reaper {
  watch(pid: number, pgid: number): void;
  unwatch(pgid: number): void;
  /** Optional additions: the watcher pid for a group (tests, diagnostics). */
  watcherPid?(pgid: number): number | undefined;
}

/** `opts.ownerPid` defaults to the current process (Pi); tests pass a stand-in owner they spawned. */
export function createReaper(opts: { ownerPid?: number } = {}): Reaper | null {
  if (process.platform === "win32") return null;
  const watchers = new Map<number, number>(); // pgid -> watcher pid (spawned by us)
  return {
    watch(_pid, pgid) {
      if (watchers.has(pgid)) return;
      try {
        const w = spawn("/bin/sh", ["-c", REAPER_SCRIPT, "pi-bg-reaper", String(opts.ownerPid ?? process.pid), String(pgid)], {
          detached: true,
          stdio: "ignore",
        });
        w.on("error", () => {});
        w.once("exit", () => watchers.delete(pgid));
        w.unref();
        if (w.pid !== undefined) watchers.set(pgid, w.pid);
      } catch {
        /* reaper is best effort */
      }
    },
    watcherPid: (pgid) => watchers.get(pgid),
    unwatch(pgid) {
      const wpid = watchers.get(pgid);
      watchers.delete(pgid);
      if (wpid === undefined) return;
      try { process.kill(wpid, "SIGKILL"); } catch { /* already exited */ } // a pid we spawned
    },
  };
}
