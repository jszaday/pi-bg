// TypeBox parameter schemas for the five pi-bg tools (DESIGN section 5). Wire keys are snake_case.
// TypeBox comes from the Pi host (peer dependency), so this module is outside src/core.

import { Type, type Static } from "typebox";

const seconds = (description: string) => Type.Number({ minimum: 0, description });
const count = (description: string) => Type.Integer({ minimum: 0, description });

export const BashParams = Type.Object({
  command: Type.String({ minLength: 1, description: "Shell command to run." }),
  timeout: Type.Optional(seconds("Hard kill limit in seconds, measured from start. Absent means no limit.")),
  bg_timeout: Type.Optional(
    seconds("Seconds the call may run in the foreground before it moves to the background. 0 disables the handoff. Keep it below timeout."),
  ),
  run_in_background: Type.Optional(Type.Boolean({ description: "Start as a background task at once. Default false." })),
  notify: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("error"), Type.Literal("done")], {
      description: "Notification level for this task. Absent means the configured default.",
    }),
  ),
  description: Type.Optional(Type.String({ description: "Short label shown in task lists." })),
});

export const BgStatusParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id such as bg3. Absent lists all tasks." })),
  tail_lines: Type.Optional(count("Output lines to include. Default 10 for one task, 0 for the list.")),
  include_finished: Type.Optional(Type.Boolean({ description: "Include finished tasks. Default false (only running tasks are listed)." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum tasks per page. Default 10." })),
  offset: Type.Optional(count("Tasks to skip, for the next page. Default 0.")),
});

export const BgOutputParams = Type.Object({
  id: Type.String({ description: "Task id such as bg3." }),
  tail_lines: Type.Optional(count("Lines to return from the end. Default 50.")),
  since: Type.Optional(count("Byte cursor from a previous call; returns only newer output.")),
  grep: Type.Optional(Type.String({ description: "JavaScript regular expression, applied per line." })),
  context: Type.Optional(count("Lines of context around each grep match.")),
  max_bytes: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum bytes returned. Default 16000." })),
  stream: Type.Optional(
    Type.Union([Type.Literal("combined"), Type.Literal("stdout"), Type.Literal("stderr")], {
      description: "Which output to read. Default combined; stdout and stderr need a runner that splits them.",
    }),
  ),
});

export const BgWaitParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String(), { description: "Task ids to wait for. Absent means all running background tasks." })),
  mode: Type.Optional(
    Type.Union([Type.Literal("any"), Type.Literal("all")], {
      description: "any returns when one listed task ends; all waits for every listed task. Default any.",
    }),
  ),
  timeout_s: Type.Optional(
    Type.Number({ minimum: 0, maximum: 3600, description: "Seconds to wait at most. Default 120, maximum 3600." }),
  ),
});

export const BgKillParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id to kill. Give id or all, not both." })),
  all: Type.Optional(Type.Boolean({ description: "Kill every running background task. Give id or all, not both." })),
});

export type ToolName = "bash" | "bg_status" | "bg_output" | "bg_wait" | "bg_kill";

export const TOOL_NAMES: readonly ToolName[] = ["bash", "bg_status", "bg_output", "bg_wait", "bg_kill"];

export const SCHEMAS = {
  bash: BashParams,
  bg_status: BgStatusParams,
  bg_output: BgOutputParams,
  bg_wait: BgWaitParams,
  bg_kill: BgKillParams,
} satisfies Record<ToolName, unknown>;

export type BashArgs = Static<typeof BashParams>;
export type BgStatusArgs = Static<typeof BgStatusParams>;
export type BgOutputArgs = Static<typeof BgOutputParams>;
export type BgWaitArgs = Static<typeof BgWaitParams>;
export type BgKillArgs = Static<typeof BgKillParams>;
