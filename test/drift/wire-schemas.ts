// Response (wire) schemas for the five tools. Only parameter schemas exist in src/tools/schemas.ts, so these are the
// test-side definition of the snake_case result shape; the type-level checks in wire-schemas.test.ts tie them to the
// Wire* interfaces in src/pi/results.ts, and the round-trip tests tie them to the real producers.
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { WireHandoff, WireKill, WireOutput, WireStatus, WireWait } from "../../src/pi/results.js";
import type { ToolName } from "../../src/tools/schemas.js";

const strict = { additionalProperties: false } as const;
const TaskState = Type.Union(
  (["foreground", "background", "exited", "killed", "timed_out", "spawn_failed"] as const).map((s) => Type.Literal(s)),
);
const Notify = Type.Union([Type.Literal("off"), Type.Literal("error"), Type.Literal("done")]);
const Stream = Type.Union([Type.Literal("combined"), Type.Literal("stdout"), Type.Literal("stderr")]);
const WaitReason = Type.Union(
  (["finished", "timeout", "user_message", "aborted", "no_tasks"] as const).map((s) => Type.Literal(s)),
);
const HandoffReason = Type.Union([Type.Literal("requested"), Type.Literal("bg_timeout"), Type.Literal("user")]);

export const WireTaskSummarySchema = Type.Object(
  {
    id: Type.String(),
    label: Type.Optional(Type.String()),
    command: Type.String(),
    state: TaskState,
    started_at: Type.String(),
    runtime_s: Type.Number(),
    exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    pid: Type.Optional(Type.Number()),
    total_bytes: Type.Number(),
    notify: Notify,
    notified: Type.Boolean(),
    log_path: Type.Optional(Type.String()),
    log_degraded: Type.Boolean(),
    last_lines: Type.Optional(Type.Array(Type.String())),
  },
  strict,
);

export const WireStatusSchema = Type.Object(
  { tasks: Type.Array(WireTaskSummarySchema), total: Type.Optional(Type.Number()), next_offset: Type.Optional(Type.Number()), hidden_finished: Type.Optional(Type.Number()) },
  strict,
);

export const WireOutputSchema = Type.Object(
  {
    id: Type.String(),
    state: TaskState,
    exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    output: Type.String(),
    returned_bytes: Type.Number(),
    total_bytes: Type.Number(),
    next_cursor: Type.Number(),
    truncated: Type.Boolean(),
    stream: Stream,
    log_path: Type.Optional(Type.String()),
    log_degraded: Type.Boolean(),
  },
  strict,
);

export const WireWaitSchema = Type.Object(
  { reason: WaitReason, waited_s: Type.Number(), tasks: Type.Array(WireTaskSummarySchema) },
  strict,
);

export const WireKillSchema = Type.Object(
  {
    killed: Type.Array(Type.String()),
    already_finished: Type.Array(Type.String()),
    failed: Type.Array(Type.Object({ id: Type.String(), error: Type.String() }, strict)),
  },
  strict,
);

export const WireHandoffSchema = Type.Object(
  {
    task_id: Type.String(),
    state: Type.Literal("background"),
    reason: HandoffReason,
    runtime_s: Type.Number(),
    output_tail: Type.Array(Type.String()),
    log_path: Type.Optional(Type.String()),
    log_degraded: Type.Boolean(),
  },
  strict,
);

/** One result schema per tool name; adding a tool to ToolName fails typecheck here until it has one. */
export const RESPONSE_SCHEMAS = {
  bash: WireHandoffSchema,
  bg_status: WireStatusSchema,
  bg_output: WireOutputSchema,
  bg_wait: WireWaitSchema,
  bg_kill: WireKillSchema,
} satisfies Record<ToolName, TSchema>;

// Mutual assignability of schema type and wire interface: fails to compile when either side drifts.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const SAME_AS_WIRE = {
  bg_status: true as Same<Static<typeof WireStatusSchema>, WireStatus>,
  bg_output: true as Same<Static<typeof WireOutputSchema>, WireOutput>,
  bg_wait: true as Same<Static<typeof WireWaitSchema>, WireWait>,
  bg_kill: true as Same<Static<typeof WireKillSchema>, WireKill>,
  bash: true as Same<Static<typeof WireHandoffSchema>, WireHandoff>,
} satisfies Record<ToolName, true>;

/** Validates a tool result: content text is non-empty, details and structuredContent are identical and match the schema. */
export function checkResult(tool: ToolName, r: unknown): { ok: boolean; why: string } {
  const res = r as { content?: { type: string; text?: string }[]; structuredContent?: unknown; details?: unknown };
  const schema = RESPONSE_SCHEMAS[tool];
  if (!res.content?.some((c) => c.type === "text" && (c.text ?? "").length > 0)) return { ok: false, why: "no text content" };
  if (!Value.Check(schema, res.structuredContent)) {
    const e = [...Value.Errors(schema, res.structuredContent)][0];
    return { ok: false, why: `structuredContent ${e?.instancePath || "/"}: ${e?.message ?? "invalid"}` };
  }
  return { ok: true, why: "" };
}
