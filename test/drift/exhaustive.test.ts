// Exhaustiveness: each table must list every member of its union. When a union grows, typecheck fails here until the
// table (and so the code that consumes it) is updated.
import { describe, expect, it } from "vitest";
import type { BgKillArgs } from "../../src/tools/schemas.js";
import type { HandoffReason, KillCause, KillSignal, NotifyStatus, TaskState, TerminalState, WaitReason } from "../../src/contract.js";
import { failure, type FailureCode } from "../../src/core/format.js";

const TASK_STATE = {
  foreground: 1, background: 1, exited: 1, killed: 1, timed_out: 1, spawn_failed: 1,
} satisfies Record<TaskState, 1>;
const TERMINAL_STATE = { exited: 1, killed: 1, timed_out: 1, spawn_failed: 1 } satisfies Record<TerminalState, 1>;
const NOTIFY_STATUS = { none: 1, pending: 1, sent: 1, acked: 1, suppressed: 1 } satisfies Record<NotifyStatus, 1>;
const HANDOFF_REASON = { requested: 1, bg_timeout: 1, user: 1 } satisfies Record<HandoffReason, 1>;
const KILL_CAUSE = { bg_kill: 1, command: 1, shutdown: 1, turn_abort: 1 } satisfies Record<KillCause, 1>;
const WAIT_REASON = { finished: 1, timeout: 1, user_message: 1, aborted: 1, no_tasks: 1 } satisfies Record<WaitReason, 1>;

// Sample context per failure code; extend when a code is added.
const FAILURE_CTX = {
  unknown_id: { id: "bg9", known: "bg1" },
  stale_id: { id: "bg1" },
  spawn_failed: { cwd: "/x", shell: "/bin/sh", error: "ENOENT" },
  task_limit: { limit: 8 },
  kill_failed: { id: "bg1", error: "EPERM", pid: 42 },
  log_degraded: { id: "bg1", error: "ENOSPC", kib: 64 },
  bad_grep: { pattern: "(", error: "Unterminated group" },
  bad_override: { key: "timeout", value: "abc" },
  bash_owned: { owner: "other-ext" },
  inactive: { reason: "disabled", action: "remove --no-bg" },
  unsupported_platform: { platform: "win32" },
  wait_none: {},
  wait_timeout: { seconds: 5 },
  kill_args: { both: 1 },
  kill_signal_unsupported: { signal: "INT" },
  write_no_stdin: { id: "bg1" },
  write_finished: { id: "bg1", state: "exited" },
  write_too_large: { bytes: 70000, limit: 65536 },
  write_failed: { id: "bg1", error: "stdin was already closed" },
  stream_unsupported: { stream: "stderr" },
  notify_failed: { error: "boom" },
  listener_failed: { id: "bg1", error: "oops" },
  handoff_missing: { id: "bg1" },
  shutdown_timeout: { seconds: 5, pid: 42 },
  disabled: { foreground: 1 },
  bash_inactive: { owner: "other-ext" },
  kill_no_handle: { id: "bg1", pid: 42 },
  kill_not_exited: { id: "bg1", seconds: 5, pid: 42 },
  config_unreadable: { file: "/h/pi-bg.json", label: "global", error: "EACCES" },
  config_bad_json: { file: "/h/pi-bg.json", error: "Unexpected token" },
  log_cleanup_failed: { error: "EPERM" },
} satisfies Record<FailureCode, Record<string, string | number>>;

describe("union exhaustiveness tables", () => {
  it.each([
    ["TaskState", TASK_STATE, 6],
    ["TerminalState", TERMINAL_STATE, 4],
    ["NotifyStatus", NOTIFY_STATUS, 5],
    ["HandoffReason", HANDOFF_REASON, 3],
    ["KillCause", KILL_CAUSE, 4],
    ["WaitReason", WAIT_REASON, 5],
    ["FailureCode", FAILURE_CTX, Object.keys(FAILURE_CTX).length],
  ])("%s table has its members (compile-time exhaustive)", (_n, table, n) => {
    expect(Object.keys(table)).toHaveLength(n);
  });
  it("terminal states are a strict subset of task states", () => {
    for (const k of Object.keys(TERMINAL_STATE)) expect(k in TASK_STATE).toBe(true);
  });
});

describe("failure() covers every FailureCode", () => {
  for (const [code, ctx] of Object.entries(FAILURE_CTX) as [FailureCode, Record<string, string | number>][]) {
    it(`${code} yields non-empty cause and action text`, () => {
      const t = failure(code, ctx);
      expect(t.trim().length).toBeGreaterThan(0);
      expect(t).not.toMatch(/\bundefined\b/);
      expect(t).not.toContain("unknown"); // all placeholders were supplied
      // cause precedes the action; wait_none/wait_timeout are informational answers, not errors
      if (code !== "wait_none" && code !== "wait_timeout") expect(t).toMatch(/Action: \S/);
    });
  }
});

// bg_kill's wire enum is the uppercase form of the contract's KillSignal; a signal added to one and not the other fails to compile.
type SameType<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const KILL_SIGNAL_PARITY: SameType<Uppercase<KillSignal>, NonNullable<BgKillArgs["signal"]>> = true;
