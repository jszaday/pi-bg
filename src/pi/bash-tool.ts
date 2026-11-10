// Replacing `bash` tool (DESIGN sections 4, 5.1, 11). Foreground commands run through Pi's native bash tool,
// built per call with a custom `exec` that delegates to the ProcessRunner; a handoff makes `exec` reject with a sentinel
// error that this tool turns into a normal "moved to background" result. `run_in_background` skips the native tool.

import os from "node:os";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { HandoffReason, TaskId, TaskSpec } from "../contract.js";
import { BASH_GUIDELINES, failure } from "../core/format.js";
import { effectiveBgTimeoutMs, effectiveNotifyLevel } from "../core/timeout-policy.js";
import { BashParams, type BashArgs } from "../tools/schemas.js";
import { bashRenderResult } from "./bash-render.js";
import { toBashHandoffResult } from "./results.js";
import type { Services } from "./runtime.js";
import { startTask } from "./start-task.js";

const SENTINEL_PREFIX = "pi-bg-handoff:";
const HANDOFF_TAIL_LINES = 20;

const BG_DESCRIPTION =
  " pi-bg additions: set run_in_background to start a command in the background at once, bg_timeout (seconds) to move a slow foreground command to the background without killing it, notify (off, error, done) and description (task label).";

/** One in-flight foreground call: what the handoff needs to unblock the pending native `execute`. */
interface Foreground {
  taskId: TaskId;
  toolCallId: string;
  handedOff: boolean;
  /** Settles the pending exec by rejecting; set once the exec promise exists. */
  reject(err: Error): void;
  detach(): void;
}

interface HandoffInfo {
  taskId: TaskId;
  reason: HandoffReason;
}

/**
 * The whole sentinel/handoff mechanism in one place (DESIGN 4.1: swappable for the exit-0 fallback, where `trigger`
 * resolves exec with exit 0 and `recover` runs on the native result instead of on a caught error).
 */
export function handoffMechanism() {
  const sideTable = new Map<string, HandoffInfo>(); // toolCallId -> task, not error identity
  return {
    /** Makes the pending exec of `fg` stop with the sentinel. */
    trigger(fg: Foreground, reason: HandoffReason): void {
      fg.handedOff = true;
      fg.detach();
      sideTable.set(fg.toolCallId, { taskId: fg.taskId, reason });
      fg.reject(new Error(`${SENTINEL_PREFIX}${fg.taskId}`));
    },
    /** Maps whatever the native tool threw to a handoff, or undefined when it was an ordinary error. */
    recover(toolCallId: string, err: unknown): HandoffInfo | undefined {
      const hit = sideTable.get(toolCallId);
      if (hit) {
        sideTable.delete(toolCallId);
        return hit;
      }
      const message = err instanceof Error ? err.message : "";
      if (message.startsWith(SENTINEL_PREFIX)) return { taskId: message.slice(SENTINEL_PREFIX.length), reason: "user" };
      return undefined;
    },
  };
}

function exitCodeOf(code: number | null, signal: string | null): number | null {
  if (code !== null) return code;
  const n = signal ? os.constants.signals[signal as NodeJS.Signals] : undefined;
  return n === undefined ? null : 128 + n;
}

export function registerBashTool(
  pi: ExtensionAPI,
  s: Services,
): { handoff(id: TaskId, reason: HandoffReason): boolean; handoffAllMovable(reason: HandoffReason): TaskId[] } {
  const mechanism = handoffMechanism();
  const foregrounds = new Map<TaskId, Foreground>();
  const nativeInfo = createBashToolDefinition(process.cwd());

  function handoff(id: TaskId, reason: HandoffReason): boolean {
    const task = s.registry.get(id);
    const fg = foregrounds.get(id);
    if (!task || task.state !== "foreground" || !fg) return false; // terminal, already moved, or not ours
    s.registry.dispatch(id, { type: "handoff", reason, at: s.clock.now() });
    foregrounds.delete(id);
    mechanism.trigger(fg, reason);
    return true;
  }

  function handoffAllMovable(reason: HandoffReason): TaskId[] {
    return s.registry
      .movable()
      .map((t) => t.id)
      .filter((id) => handoff(id, reason));
  }

  function specOf(toolCallId: string, p: BashArgs, cwd: string): TaskSpec {
    return {
      command: p.command,
      cwd,
      label: p.description,
      hardTimeoutMs: p.timeout !== undefined && p.timeout > 0 ? Math.ceil(p.timeout * 1000) : null,
      bgTimeoutMs: effectiveBgTimeoutMs({
        callSeconds: p.bg_timeout,
        sessionSeconds: s.overrides.bgTimeoutSeconds,
        configSeconds: s.config().bgTimeoutSeconds,
      }),
      notify: effectiveNotifyLevel({ call: p.notify, session: s.overrides.notifyLevel, config: s.config().notify.default }),
      startInBackground: p.run_in_background === true,
      toolCallId,
    };
  }

  function handoffResult(taskId: TaskId, reason: HandoffReason): AgentToolResult<Record<string, unknown>> {
    const task = s.registry.get(taskId);
    if (!task) throw new Error(failure("handoff_missing", { id: taskId }));
    const tail = s.runtime.get(taskId)?.tail.lines(HANDOFF_TAIL_LINES) ?? [];
    return toBashHandoffResult(task, tail, task.handoffReason ?? reason);
  }

  /** Pi's `shellCommandPrefix` setting, read per call (it can change at runtime); undefined when unset or unreadable. */
  function shellPrefix(): string | undefined {
    try {
      return pi.getSettings().shellCommandPrefix || undefined;
    } catch {
      return undefined;
    }
  }

  async function runBackground(toolCallId: string, p: BashArgs, cwd: string): Promise<AgentToolResult<Record<string, unknown>>> {
    // This path skips the native tool, so the prefix is applied here the same way (native joins "prefix\ncommand").
    const prefix = shellPrefix();
    const r = startTask(s, specOf(toolCallId, p, cwd), prefix ? { runCommand: `${prefix}\n${p.command}` } : {});
    if (!r.ok) throw new Error(r.message);
    return handoffResult(r.task.id, "requested");
  }

  /** Builds the exec of one foreground call; the task is created when the native tool calls it. */
  function makeExec(toolCallId: string, p: BashArgs) {
    return (command: string, cwd: string, o: { onData: (d: Buffer) => void; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) =>
      new Promise<{ exitCode: number | null }>((resolve, reject) => {
        let settled = false;
        const fg: Foreground = {
          taskId: "",
          toolCallId,
          handedOff: false,
          reject: (err) => settle(() => reject(err)),
          detach: () => o.signal?.removeEventListener("abort", onAbort),
        };
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fg.detach();
          foregrounds.delete(fg.taskId);
          fn();
        };
        const onAbort = (): void => {
          if (settled || fg.handedOff) return;
          const task = s.registry.get(fg.taskId);
          if (task && task.state === "foreground") {
            s.registry.dispatch(fg.taskId, { type: "kill_requested", cause: "turn_abort", at: s.clock.now() });
            s.runtime.get(fg.taskId)?.handle?.kill("term");
          }
          settle(() => reject(new Error("aborted")));
        };

        const env = o.env ? Object.fromEntries(Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined)) : undefined;
        const r = startTask(s, specOf(toolCallId, p, cwd), {
          runCommand: command,
          env,
          hooks: {
            onData: (chunk) => {
              if (!fg.handedOff && !settled) o.onData(Buffer.from(chunk));
            },
            onExit: (info) => settle(() => resolve({ exitCode: exitCodeOf(info.code, info.signal) })),
            onHandoffTimer: () => {
              handoff(fg.taskId, "bg_timeout");
            },
            onHardTimeout: () => settle(() => reject(new Error(`timeout:${p.timeout}`))),
          },
        });
        if (!r.ok) return settle(() => reject(new Error(r.message)));
        fg.taskId = r.task.id;
        if (!settled) foregrounds.set(fg.taskId, fg);
        if (o.signal?.aborted) onAbort();
        else o.signal?.addEventListener("abort", onAbort, { once: true });
      });
  }

  pi.registerTool({
    name: "bash",
    label: nativeInfo.label,
    description: nativeInfo.description + BG_DESCRIPTION,
    promptSnippet: nativeInfo.promptSnippet,
    promptGuidelines: [...(nativeInfo.promptGuidelines ?? []), ...BASH_GUIDELINES],
    parameters: BashParams,
    renderShell: nativeInfo.renderShell,
    renderCall: nativeInfo.renderCall,
    renderResult: bashRenderResult(s, nativeInfo),
    async execute(toolCallId: string, params: BashArgs, signal, onUpdate, ctx: ExtensionToolContext) {
      s.ctx.current = ctx;
      const cwd = ctx?.cwd || process.cwd();
      const inactiveText = s.inactiveReason?.();
      if (!s.config().enabled || inactiveText) {
        // Pass-through: Pi's own bash with its default operations. A call that needs pi-bg (background, bg_timeout, notify) must not silently run in the foreground.
        if (params.run_in_background === true || params.bg_timeout !== undefined || params.notify !== undefined) {
          const message = inactiveText ?? failure("disabled", { foreground: 1 });
          s.ui.notify(message, "error");
          throw new Error(message);
        }
        return createBashToolDefinition(cwd).execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (params.run_in_background === true) return runBackground(toolCallId, params, cwd);
      const native = createBashToolDefinition(cwd, { operations: { exec: makeExec(toolCallId, params) }, commandPrefix: shellPrefix() });
      try {
        return await native.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (err) {
        const hit = mechanism.recover(toolCallId, err);
        if (!hit) throw err;
        return handoffResult(hit.taskId, hit.reason);
      }
    },
  });

  return { handoff, handoffAllMovable };
}
