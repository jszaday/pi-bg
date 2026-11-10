// `/bg` command (DESIGN section 14). Output goes through ctx.ui.notify (stderr in print/json), not the session transcript,
// so command replies never enter the model context or the saved session.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TaskId } from "../contract.js";
import { bgCommandText, failure, killText, summaryText, type KillResult } from "../core/format.js";
import type { TaskRegistry } from "../core/registry.js";
import { notifyUser } from "./ui.js";

const SUBCOMMANDS = ["kill", "tail", "timeout", "notify", "move", "help"] as const;
const NOTIFY_LEVELS = ["off", "error", "done"];

export function registerBgCommand(
  pi: ExtensionAPI,
  deps: {
    registry: TaskRegistry;
    kill: (id: TaskId | "all") => Promise<KillResult>;
    move: () => TaskId[];
    /** W8's setSessionOverride bound to Services; returns the confirmation or error text. */
    setSession: (k: "timeout" | "notify", v: string) => string;
    /** Last lines of a task's output (the runtime tail, owned by W6). */
    tailOf?: (id: TaskId) => string[] | Promise<string[]>;
    /** Opens the shells panel (TUI only); `/bg` without arguments uses it when present. */
    openPanel?: (ctx: ExtensionCommandContext) => void;
  },
): void {
  const { registry } = deps;

  /** Error text when `id` is not a task of this session, else undefined. */
  const badId = (id: string): string | undefined => {
    if (registry.get(id)) return undefined;
    if (registry.isStale(id)) return failure("stale_id", { id });
    return failure("unknown_id", { id, known: registry.list().map((t) => t.id).join(", ") || "none" });
  };

  pi.registerCommand("bg", {
    description: "List, tail, kill or move background tasks (/bg help)",
    getArgumentCompletions(prefix) {
      const m = /^(\S*)(?:\s+(.*))?$/.exec(prefix.trimStart());
      if (!m) return null;
      const [, sub, rest] = m;
      if (rest === undefined) {
        const items = SUBCOMMANDS.filter((s) => s.startsWith(sub)).map((s) => ({ value: s, label: s }));
        return items.length > 0 ? items : null;
      }
      let choices: string[] = [];
      if (sub === "kill") choices = ["all", ...registry.running().map((t) => t.id)];
      else if (sub === "tail") choices = registry.list().map((t) => t.id);
      else if (sub === "notify") choices = NOTIFY_LEVELS;
      const items = choices.filter((c) => c.startsWith(rest)).map((c) => ({ value: `${sub} ${c}`, label: c }));
      return items.length > 0 ? items : null;
    },
    async handler(args, ctx) {
      const say = (text: string, level: "info" | "warning" | "error" = "info"): void => notifyUser(ctx, text, level);
      const [sub = "", arg = ""] = args.trim().split(/\s+/, 2);
      switch (sub) {
        case "":
          if (deps.openPanel && ctx.mode === "tui" && ctx.hasUI) return deps.openPanel(ctx);
        // falls through: no panel here, so the text list
        case "list": {
          const list = registry.list().map((t) => registry.summarize(t));
          say(list.length === 0 ? summaryText(list) : `${bgCommandText("list", { count: list.length })}\n${summaryText(list)}`);
          return;
        }
        case "tail": {
          const err = badId(arg);
          if (err !== undefined) return say(err, "error");
          const task = registry.get(arg)!;
          say(`${bgCommandText("tail", { id: arg })}\n${summaryText([registry.summarize(task)], (await deps.tailOf?.(arg)) ?? [])}`);
          return;
        }
        case "kill": {
          if (arg === "") return say(bgCommandText("help", {}), "warning");
          if (arg !== "all") {
            const err = badId(arg);
            if (err !== undefined) return say(err, "error");
          }
          const r = await deps.kill(arg === "all" ? "all" : arg);
          if (r.failed.length > 0) say(killText(r), "error");
          else say(bgCommandText("kill", { count: r.killed.length }));
          return;
        }
        case "timeout":
        case "notify":
          say(deps.setSession(sub, arg));
          return;
        case "move":
          say(bgCommandText("move", { count: deps.move().length }));
          return;
        case "help":
          say(bgCommandText("help", {}));
          return;
        default:
          say(bgCommandText("help", {}), "warning");
      }
    },
  });
}
