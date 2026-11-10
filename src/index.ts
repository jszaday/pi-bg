// Composition root (DESIGN section 12): builds Services from adapters, registers tools, command, flags, renderer and event handlers.
import { fileURLToPath } from "node:url";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createFsLogStore, createOwnSpawnRunner, createPiOpsRunner, createReaper, piShellEnv, resolveBaseDir, resolveShell, systemClock,
} from "./adapters/index.js";
import type { BgConfig, LogStore, ProcessRunner, TaskId } from "./contract.js";
import { DEFAULT_CONFIG } from "./core/config.js";
import { failure } from "./core/format.js";
import { createIdAllocator } from "./core/ids.js";
import { NotificationPolicy } from "./core/notify-policy.js";
import { TaskRegistry } from "./core/registry.js";
import { WaitCoordinator } from "./core/wait.js";
import { registerBashTool } from "./pi/bash-tool.js";
import { registerBgTools } from "./pi/bg-tools.js";
import { registerBgCommand } from "./pi/command.js";
import { registerFlags, setSessionOverride } from "./pi/config-load.js";
import { installInputHandler } from "./pi/input-handler.js";
import { installMoveKey } from "./pi/input.js";
import { killTasks } from "./pi/kill.js";
import { installLifecycle } from "./pi/lifecycle.js";
import { createNotificationSink, installNotifyHandlers } from "./pi/notify.js";
import { registerNotificationRenderer } from "./pi/renderer.js";
import type { Services, TaskRuntime } from "./pi/runtime.js";
import { createUi } from "./pi/ui.js";

const NOTIFICATION_TAIL_LINES = 10;

export default function piBg(pi: ExtensionAPI): void {
  let config: BgConfig = DEFAULT_CONFIG; // until session_start loads the files and flags
  const getConfig = () => config;

  let alloc = createIdAllocator(0);
  let lastIssued = 0; // ids already used in this process stay reserved when a later session_start reseeds
  const ids = {
    next: () => {
      const id = alloc.next();
      lastIssued = Number(id.slice(2));
      return id;
    },
    get seed() { return alloc.seed; },
  };
  const clock = systemClock;
  const registry = new TaskRegistry({ clock, ids });
  const runtime = new Map<TaskId, TaskRuntime>();
  const ctxRef: Services["ctx"] = {};
  const sessionId = () => {
    try {
      return ctxRef.current?.sessionManager.getSessionId() ?? "nosession";
    } catch {
      return "nosession";
    }
  };

  // Shell resolved lazily at first use (Pi settings shellPath when obtainable), fallback to Pi's local operations if own-spawn setup fails.
  let runnerCache: ProcessRunner | undefined;
  const runner = (): ProcessRunner => {
    if (runnerCache) return runnerCache;
    let shellPath: string | undefined;
    try {
      shellPath = pi.getSettings().shellPath;
    } catch {
      shellPath = undefined;
    }
    const shell = resolveShell(shellPath);
    // commandPrefix stays unset here: the per-call native bash tool is built with Pi's shellCommandPrefix and delivers "prefix\ncommand" (S2), and run_in_background prepends it itself, so adding it here would double it.
    runnerCache =
      "error" in shell
        ? createPiOpsRunner(createLocalBashOperations())
        : createOwnSpawnRunner({ shell: shell.shell, shellArgs: shell.shellArgs, env: () => piShellEnv(), termGraceMs: config.kill.termGraceMs });
    return runnerCache;
  };

  let storeCache: LogStore | undefined;
  const store = (): LogStore =>
    (storeCache ??= createFsLogStore({ baseDir: resolveBaseDir(config.output.logDir), sessionId: sessionId(), maxLogBytes: config.output.maxLogBytes }));
  const logs: LogStore = {
    open: (id) => store().open(id),
    read: (id, stream, offset, max) => store().read(id, stream, offset, max),
    gc: (olderThanMs) => store().gc(olderThanMs),
  };

  const tailOf = (id: TaskId, n: number) => runtime.get(id)?.tail.lines(n) ?? [];
  const notifyConfig = {
    get default() { return config.notify.default; },
    get delivery() { return config.notify.delivery; },
    get wake() { return config.notify.wake; },
    get batchMs() { return config.notify.batchMs; },
  };
  // The policy reports via ui.notify; `s` is assigned below, before any event can fire.
  const notify = new NotificationPolicy({
    clock,
    config: notifyConfig,
    registry,
    sink: createNotificationSink(pi, (e) => s.ui.notify(failure("notify_failed", { error: (e as Error).message }), "warning")),
    summarize: (t) => {
      const tail = tailOf(t.id, NOTIFICATION_TAIL_LINES);
      return { task: registry.summarize(t, tail), tail };
    },
  });
  const waits = new WaitCoordinator({
    clock,
    registry,
    get maxWaitMs() { return config.wait.maxTimeoutSeconds * 1000; },
    confirmQueued: () => ctxRef.current?.hasPendingMessages?.(),
  });
  registry.subscribe((t, ev, applied) => {
    notify.onTaskEvent(t, ev, applied);
    waits.onTaskEvent(t, ev, applied);
  });

  const ui = createUi(pi, { registry });

  const s: Services = {
    clock,
    config: getConfig,
    registry,
    runtime,
    runner,
    logs,
    overrides: {},
    ctx: ctxRef,
    waits,
    notify,
    ui,
    sessionId,
    reaper: createReaper(),
  };

  registerFlags(pi);
  const bash = registerBashTool(pi, s);
  registerBgTools(pi, s);
  registerBgCommand(pi, {
    registry,
    kill: (id) => killTasks(s, id === "all" ? "all" : [id], "command"),
    move: () => bash.handoffAllMovable("user"),
    setSession: (k, v) => setSessionOverride(s, k, v),
    tailOf: (id) => tailOf(id, config.output.tailLines),
  });
  registerNotificationRenderer(pi);
  installInputHandler(pi, s);
  installNotifyHandlers(pi, notify);
  const lifecycle = installLifecycle(pi, s, {
    reseed: (seed) => { alloc = createIdAllocator(Math.max(seed, lastIssued)); },
    setConfig: (c) => { config = c; runnerCache = undefined; storeCache = undefined; },
    bash: () => bash,
    installKey: (ctx, k) => installMoveKey(ctx, { registry, ...k }),
    ui,
    ownPath: fileURLToPath(import.meta.url),
  });
  s.inactiveReason = lifecycle.inactiveReason;
}
