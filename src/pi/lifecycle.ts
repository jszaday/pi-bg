// Session lifecycle glue (DESIGN section 12): session_start setup, session_shutdown cleanup, exit backstop.
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BgConfig, HandoffReason, TaskId } from "../contract.js";
import { failure } from "../core/format.js";
import { seedFromBranch } from "../core/ids.js";
import { killTasks } from "./kill.js";
import { loadConfig } from "./config-load.js";
import { killBoundMs, type Services } from "./runtime.js";

/** Overall shutdown bound: a little beyond the per-task kill bound, so killTasks reports its own failures first. */
export const shutdownBoundMs = (s: Services): number => killBoundMs(s.config().kill.termGraceMs) + 1000;
const DAY_MS = 86_400_000;

export interface LifecycleDeps {
  /** Replaces the id allocator so the next id is above `seed`. */
  reseed(seed: number): void;
  /** Receives the merged config after each session_start. */
  setConfig(config: BgConfig): void;
  /** The bash tool handle; read lazily because the tool is registered after the lifecycle. */
  bash: () => { handoffAllMovable(reason: HandoffReason): TaskId[] } | undefined;
  /** installMoveKey from input.ts (W7); returns the unsubscribe. */
  installKey: (ctx: ExtensionContext, deps: { key: () => string; move: () => TaskId[] }) => () => void;
  /** createUi result (W7). */
  ui: { onSessionStart(ctx: ExtensionContext): void; dispose(): void };
  /** Absolute path of pi-bg's entry file, to recognise our own `bash` registration (S7). */
  ownPath?: string;
  platform?: string;
  /** Test seams for the exit backstop. */
  proc?: { on(ev: "exit", fn: () => void): unknown; off(ev: "exit", fn: () => void): unknown };
  killGroup?: (pgid: number) => void;
}

export interface Lifecycle {
  /** Wire to Services.inactiveReason. */
  inactiveReason(): string | undefined;
}

const shutdowns = new WeakMap<Services, Promise<void>>();

function killGroupDefault(pgid: number): void {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // group already gone or not ours: nothing left to signal
  }
}

/**
 * Synchronous last resort: SIGKILL every still-registered running task, then the leftover members of finished tasks' groups
 * (a job started with `&` outlives its task, #18; the handle ignores a group it saw empty, so a reused id is never signalled).
 * Used after the 5 s bound and from the exit backstop.
 */
function hardKill(s: Services, killGroup: (pgid: number) => void): void {
  const running = new Set(s.registry.running().map((t) => t.id));
  for (const [id, rt] of s.runtime) {
    if (running.has(id)) continue;
    try {
      rt.handle?.kill("kill");
    } catch {
      // handle already dead
    }
  }
  for (const t of s.registry.running()) {
    try {
      s.runtime.get(t.id)?.handle?.kill("kill");
    } catch {
      // handle already dead
    }
    if (t.pid !== undefined) killGroup(t.pid); // own-spawn: the child leads its process group
  }
}

/** Idempotent: kills all tasks (cause shutdown), bounded at 5 s on the clock; stragglers get a synchronous SIGKILL. */
export function killAll(s: Services, killGroup: (pgid: number) => void = killGroupDefault): Promise<void> {
  const prior = shutdowns.get(s);
  if (prior) return prior;
  const p = (async () => {
    let timer: unknown;
    const boundMs = shutdownBoundMs(s);
    const bound = new Promise<"bound">((resolve) => {
      timer = s.clock.setTimeout(() => resolve("bound"), boundMs);
    });
    try {
      const r = await Promise.race([killTasks(s, "all", "shutdown"), bound]);
      if (r === "bound") {
        const pids = s.registry.running().flatMap((t) => (t.pid === undefined ? [] : [t.pid]));
        s.ui.notify(failure("shutdown_timeout", { seconds: boundMs / 1000, ...(pids.length > 0 && { pid: pids.join(", ") }) }), "warning");
      } else {
        for (const f of r.failed) s.ui.notify(f.error, "warning");
      }
    } catch (e) {
      s.ui.notify(failure("kill_failed", { id: "all", error: (e as Error).message }), "warning");
    } finally {
      s.clock.clearTimeout(timer);
    }
    hardKill(s, killGroup);
  })();
  shutdowns.set(s, p);
  return p;
}

function branchTexts(ctx: ExtensionContext): string[] {
  const texts: string[] = [];
  let entries: unknown[];
  try {
    entries = ctx.sessionManager.getBranch();
  } catch {
    return texts;
  }
  for (const e of entries as { type?: string; message?: { role?: string; content?: unknown; details?: unknown }; content?: unknown; details?: unknown }[]) {
    const src = e.type === "message" && e.message?.role === "toolResult" ? e.message : e.type === "custom_message" ? e : undefined;
    if (!src) continue;
    if (typeof src.content === "string") texts.push(src.content);
    else if (Array.isArray(src.content)) for (const c of src.content as { text?: unknown }[]) if (typeof c?.text === "string") texts.push(c.text);
    if (src.details !== undefined) texts.push(JSON.stringify(src.details));
  }
  return texts;
}

function owner(pi: ExtensionAPI, ownPath: string | undefined): string | undefined {
  if (ownPath === undefined) return undefined;
  let path: string | undefined;
  try {
    path = pi.getAllTools().find((t) => t.name === "bash")?.sourceInfo?.path;
  } catch {
    return undefined; // S7: if Pi stops reporting the owner, skip the warning
  }
  if (path === undefined) return undefined;
  // Pi reports an inline extension factory (`<inline:N>`) as a path starting with `<`; that is ours. Real installs load by path, so this only matters for SDK/embedded use.
  if (path.startsWith("<")) return undefined;
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  const own = real(ownPath);
  const other = real(path);
  return other === own || own.startsWith(other + sep) ? undefined : path;
}

export function installLifecycle(pi: ExtensionAPI, s: Services, deps: LifecycleDeps): Lifecycle {
  const proc = deps.proc ?? process;
  const killGroup = deps.killGroup ?? killGroupDefault;
  let inactive: string | undefined;
  let unsubscribeKey: (() => void) | undefined;
  const backstop = () => hardKill(s, killGroup);
  let backstopOn = false;

  const warn = (msg: string) => s.ui.notify(msg, "warning");

  pi.on("session_start", async (_event, ctx) => {
    shutdowns.delete(s);
    s.ctx.current = ctx;
    inactive = undefined;
    deps.ui.onSessionStart(ctx); // first, so the warnings below reach ctx.ui.notify rather than stderr
    const platform = deps.platform ?? process.platform;
    if (platform === "win32") {
      inactive = failure("unsupported_platform", { platform: "Windows" });
      warn(inactive);
      return;
    }
    const { config, warnings } = loadConfig(pi, ctx);
    deps.setConfig(config);
    for (const w of warnings) warn(w);

    deps.reseed(seedFromBranch(branchTexts(ctx)));
    try {
      await s.logs.gc(s.config().output.logRetentionDays * DAY_MS);
    } catch (e) {
      warn(failure("log_cleanup_failed", { error: (e as Error).message }));
    }

    const other = owner(pi, deps.ownPath);
    if (other !== undefined) {
      inactive = failure("bash_inactive", { owner: other });
      warn(failure("bash_owned", { owner: other }));
    }

    unsubscribeKey?.();
    unsubscribeKey = deps.installKey(ctx, {
      key: () => s.config().key,
      move: () => deps.bash()?.handoffAllMovable("user") ?? [],
    });
    if (!backstopOn) {
      proc.on("exit", backstop);
      backstopOn = true;
    }
  });

  // Executed in tmux (spike S6): Pi awaits async session_shutdown on every path but never kills extension tasks; "exit" does not fire on reload/new/resume, so this handler is the primary path and the exit backstop covers the rest.
  pi.on("session_shutdown", async () => {
    for (const rt of s.runtime.values()) for (const t of rt.timers) s.clock.clearTimeout(t);
    s.notify.discard(); // a message now would wake a dying session; tasks killed below are suppressed anyway
    // TODO(#13) P3 (wait dispose): WaitCoordinator has no dispose, so an active bg_wait keeps its timer (up to maxTimeoutSeconds) after shutdown.
    await killAll(s, killGroup);
    for (const rt of s.runtime.values()) {
      try {
        await rt.log?.close();
      } catch {
        // log already closed or failing; the task's logDegraded carries the cause
      }
    }
    deps.ui.dispose();
    unsubscribeKey?.();
    unsubscribeKey = undefined;
    if (backstopOn) {
      proc.off("exit", backstop);
      backstopOn = false;
    }
    s.ctx.current = undefined;
  });

  return { inactiveReason: () => inactive };
}
