import { spawn } from "node:child_process";
import { statSync, accessSync, constants } from "node:fs";
import type { ExitInfo, OutputSink, ProcessHandle, ProcessRunner, RunSpec } from "../contract.js";

/** After the shell exits, wait this long for stdio to end (a grandchild may hold the pipes) before resolving; same value as Pi's native tool. */
const EXIT_STDIO_GRACE_MS = 100;

/** After the leader exits with members left in its group (a job started with `&`), poll this often to notice the group emptying; from then on the group id is never signalled again. */
const GROUP_POLL_MS = 500;

export interface OwnSpawnOptions {
  shell: string;
  shellArgs: string[];
  /** Applied as "prefix\ncommand" (native joining). Leave unset when RunSpec.command already carries the prefix (Pi's bash tool applies it before exec). */
  commandPrefix?: string;
  env: () => Record<string, string>;
  termGraceMs: number;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

/** The runner also exposes the shell it spawns, so spawn failures can name it. */
export function createOwnSpawnRunner(opts: OwnSpawnOptions): ProcessRunner & { readonly shell: string } {
  return {
    shell: opts.shell,
    capabilities: { pid: true, splitStreams: true, gracefulTerm: true },
    start(spec: RunSpec, sink: OutputSink): ProcessHandle | { startError: string } {
      try {
        if (!statSync(spec.cwd).isDirectory()) throw new Error("not a directory");
      } catch {
        return { startError: `Working directory does not exist: ${spec.cwd}\nCannot execute bash commands. Run the command from an existing directory.` };
      }
      try {
        accessSync(opts.shell, constants.X_OK);
      } catch {
        if (opts.shell.includes("/")) return { startError: `Shell not found or not executable: ${opts.shell}. Set a valid shell path in Pi settings.` };
      }
      const child = spawn(opts.shell, [...opts.shellArgs, opts.commandPrefix ? `${opts.commandPrefix}\n${spec.command}` : spec.command], {
        cwd: spec.cwd,
        detached: true, // own session and process group: group signals reach grandchildren
        env: spec.env ?? opts.env(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let resolveExit!: (e: ExitInfo) => void;
      const exited = new Promise<ExitInfo>((r) => (resolveExit = r));
      let settled = false;
      let leaderExited = false;
      let graceTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let ended = 0;
      let groupGone = false;
      let groupPoll: NodeJS.Timeout | undefined;
      const markGone = () => {
        groupGone = true;
        if (groupPoll) clearInterval(groupPoll);
        groupPoll = undefined;
      };
      let info: ExitInfo = { code: null, signal: null };
      const finish = () => {
        if (settled) return;
        settled = true;
        if (graceTimer) clearTimeout(graceTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveExit(info);
      };
      const onEnd = () => {
        ended++;
        if (leaderExited && ended >= 2) finish();
      };
      child.stdout!.on("data", (b: Buffer) => sink(b, "stdout"));
      child.stderr!.on("data", (b: Buffer) => sink(b, "stderr"));
      child.stdout!.once("end", onEnd);
      child.stderr!.once("end", onEnd);
      child.once("error", (err) => {
        // Async spawn failure (e.g. EACCES after the sync checks): report on stderr and exit with code 126, the shell convention.
        sink(Buffer.from(`pi-bg: failed to start shell ${opts.shell}: ${err.message}\n`), "stderr");
        info = { code: 126, signal: null };
        finish();
      });
      child.once("exit", (code, signal) => {
        leaderExited = true;
        info = { code, signal };
        // Members left behind (`sleep 300 &`) stay ours to kill until the group is seen empty; once it is, the id may be reused by an unrelated group.
        const leader = child.pid;
        if (leader === undefined || !groupAlive(leader)) markGone();
        else {
          groupPoll = setInterval(() => { if (!groupAlive(leader)) markGone(); }, GROUP_POLL_MS);
          groupPoll.unref();
        }
        if (ended >= 2) finish();
        else graceTimer = setTimeout(finish, EXIT_STDIO_GRACE_MS);
      });
      child.once("close", finish);
      const pid = child.pid;
      if (pid === undefined) return { startError: `Could not start shell ${opts.shell}. Check the shell path and permissions.` };
      return {
        pid,
        exited,
        kill(signal) {
          // Never signal a group seen empty (its id could be reused). Stragglers after the leader exited are still ours to kill.
          if (groupGone || (leaderExited && !groupAlive(pid))) { markGone(); return; }
          if (signal === "kill") {
            if (killTimer) clearTimeout(killTimer);
            killTimer = undefined;
            signalGroup(pid, "SIGKILL");
            return;
          }
          if (killTimer) return; // a signal was already sent and escalation is pending: idempotent
          signalGroup(pid, `SIG${signal.toUpperCase()}` as NodeJS.Signals);
          killTimer = setTimeout(() => {
            // Escalate even if the leader died on the signal: a grandchild may have ignored it.
            if (!groupGone && groupAlive(pid)) signalGroup(pid, "SIGKILL");
          }, opts.termGraceMs);
          killTimer.unref();
        },
      };
    },
  };
}
