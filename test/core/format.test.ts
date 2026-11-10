import { describe, expect, it } from "vitest";
import {
  BASH_GUIDELINES,
  bgCommandText,
  failure,
  footerText,
  handoffText,
  killText,
  notificationText,
  outputText,
  summaryText,
  waitText,
  type FailureCode,
} from "../../src/core/format.js";
import type { Task, TaskSummary } from "../../src/contract.js";

function summary(n: number, over: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: `bg${n}`,
    label: `job ${n}`,
    command: `sleep ${n}`,
    state: "background",
    startedAt: "2024-01-01T00:00:00.000Z",
    runtimeS: 12,
    totalBytes: 0,
    notify: "done",
    notified: false,
    logDegraded: false,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "bg4",
    spec: {
      command: "npm run dev",
      cwd: "/work",
      hardTimeoutMs: null,
      bgTimeoutMs: 30000,
      notify: "done",
      startInBackground: false,
    },
    state: "background",
    startedAt: 1000,
    handoffAt: 31000,
    handoffReason: "bg_timeout",
    logDegraded: false,
    totalBytes: 0,
    notifyStatus: "none",
    notifyRedelivered: false,
    logPath: "/tmp/pi-bg-1000/s1/bg4.log",
    ...over,
  };
}

describe("footerText (golden)", () => {
  it("is undefined with nothing running and counts otherwise", () => {
    expect(footerText(0)).toBeUndefined();
    expect(footerText(1)).toBe("1 shell");
    expect(footerText(6)).toBe("6 shells");
  });
});

describe("bgCommandText (golden)", () => {
  it("help lists every subcommand", () => {
    const text = bgCommandText("help", {});
    for (const sub of ["/bg lists", "/bg tail <id>", "/bg kill <id|all>", "/bg timeout <seconds>", "/bg notify <off|error|done>", "/bg move"]) {
      expect(text).toContain(sub);
    }
  });

  it("list, kill and move report zero and non-zero counts", () => {
    expect(bgCommandText("list", { count: 0 })).toBe("No background tasks in this session.");
    expect(bgCommandText("list", { count: 2 })).toBe(
      "2 background task(s) in this session. Use /bg tail <id> for output, or bg_status for details.",
    );
    expect(bgCommandText("kill", { count: 0 })).toBe("No running background task to kill. Use /bg to list tasks.");
    expect(bgCommandText("kill", { count: 3 })).toBe("Killed 3 background task(s).");
    expect(bgCommandText("move", { count: 0 })).toBe("No foreground command to move to the background.");
    expect(bgCommandText("move", { count: 1 })).toBe("Moved 1 command(s) to the background.");
  });

  it("tail names the id", () => {
    expect(bgCommandText("tail", { id: "bg2" })).toBe(
      "Showing the end of bg2. Use bg_output with id bg2 to read more.",
    );
  });

  it("timeout and notify say the change is session only", () => {
    expect(bgCommandText("timeout", { seconds: 0 })).toBe(
      "Automatic handoff is off for new commands in this session (not saved).",
    );
    expect(bgCommandText("timeout", { seconds: 45 })).toBe(
      "Commands now move to the background after 45s in this session (not saved).",
    );
    expect(bgCommandText("notify", { level: "error" })).toBe(
      "Notification level for new tasks is now error in this session (not saved).",
    );
  });
});

describe("handoffText (golden)", () => {
  it("states the bg_timeout reason, the log and the follow-up tools", () => {
    expect(handoffText(task(), ["server up", "listening"], "bg_timeout")).toBe(
      [
        "Still running after 30s (bg_timeout), so it was moved to the background as bg4. It was not killed. You will be notified when it ends (notify=done).",
        "Last 2 lines:\nserver up\nlistening",
        "Log: /tmp/pi-bg-1000/s1/bg4.log.",
        "Use bg_wait, bg_output or bg_kill with id bg4. Note: changes the command makes to its working directory do not carry over.",
      ].join("\n"),
    );
  });

  it("uses the requested and user reasons and the notify off wording", () => {
    const requested = handoffText(task({ handoffReason: "requested", handoffAt: 1000 }), [], "requested");
    expect(requested).toContain("You asked for background execution, so bg4 is running in the background.");
    expect(requested).toContain("No output yet.");
    const user = handoffText(task({ spec: { ...task().spec, notify: "off" } }), [], "user");
    expect(user).toContain("The user moved it to the background with ctrl+b");
    expect(user).toContain("Notifications are off for it; check with bg_status or bg_wait.");
  });
});

describe("summaryText (golden)", () => {
  it("says so when there are no tasks", () => {
    expect(summaryText([])).toBe("No background tasks in this session. Start one with bash and run_in_background true.");
  });

  it("renders a table for a list", () => {
    const text = summaryText([
      summary(1),
      summary(2, { state: "exited", exitCode: 0, runtimeS: 3, notify: "error" }),
    ]);
    expect(text).toBe(
      [
        "id   state       runtime  exit  notify  label or command",
        "bg1  background  12s      -     done    job 1",
        "bg2  exited      3s       0     error   job 2",
      ].join("\n"),
    );
  });

  it("renders a block with the tail for one task", () => {
    const text = summaryText([summary(3, { state: "exited", exitCode: 1, notified: true, pid: 99, logPath: "/l/bg3.log" })], [
      "boom",
    ]);
    expect(text).toBe(
      [
        "bg3 (job 3): exited with code 1, runtime 12s, 0 bytes.",
        "Command: sleep 3",
        "Notification: done, already reported.",
        "pid 99.",
        "Log: /l/bg3.log.",
        "boom",
      ].join("\n"),
    );
  });
});

describe("outputText (golden)", () => {
  it("states the cursor and the truncation", () => {
    expect(
      outputText({
        id: "bg5",
        state: "exited",
        exitCode: 0,
        output: "line a\nline b",
        returnedBytes: 13,
        totalBytes: 40,
        nextCursor: 13,
        truncated: true,
        stream: "combined",
        logPath: "/l/bg5.log",
      }),
    ).toBe(
      [
        "bg5 exited, exit code 0. Stream combined: returned 13 of 40 bytes, next cursor 13.",
        "line a\nline b",
        "Output was cut at max_bytes. Call bg_output with since 13 for the rest.",
        "Log: /l/bg5.log.",
      ].join("\n"),
    );
  });

  it("says when a range is empty", () => {
    const text = outputText({ id: "bg5", state: "background", output: "", returnedBytes: 0, totalBytes: 0, nextCursor: 0, truncated: false, stream: "stdout" });
    expect(text).toBe("bg5 background. Stream stdout: returned 0 of 0 bytes, next cursor 0.\n(no output in this range)");
  });
});

describe("waitText (golden)", () => {
  const finished = summary(7, { state: "exited", exitCode: 0, lastLines: ["done"] });

  it("has one head per reason", () => {
    expect(waitText({ reason: "finished", waitedS: 4, tasks: [finished] })).toBe(
      [
        "The wait finished after 4s: a task you were waiting for has ended.",
        "- bg7 (job 7): exited with code 0, runtime 12s\n    done",
      ].join("\n"),
    );
    expect(waitText({ reason: "timeout", waitedS: 120, tasks: [] })).toBe(
      "The wait timed out after 120s with tasks still running. Action: call bg_wait again, or use bg_status to check progress.",
    );
    expect(waitText({ reason: "aborted", waitedS: 2, tasks: [] })).toBe(
      "The wait was cancelled after 2s. Background tasks keep running.",
    );
    expect(waitText({ reason: "no_tasks", waitedS: 0, tasks: [] })).toBe(
      "No background task is running, so there was nothing to wait for. Action: start a command with run_in_background, or use bg_status to see finished tasks.",
    );
    expect(waitText({ reason: "user_message", waitedS: 1, tasks: [] })).toBe(
      "The wait ended after 1s because the user sent a message. Read the user's message first; the tasks below are still listed.",
    );
  });
});

describe("killText (golden)", () => {
  it("reports killed, finished and failed entries", () => {
    expect(
      killText({
        killed: ["bg1", "bg2"],
        alreadyFinished: ["bg3"],
        failed: [{ id: "bg4", error: "EPERM" }],
      }),
    ).toBe(
      [
        "Killed: bg1, bg2.",
        "Already finished, nothing to kill: bg3.",
        "Could not stop bg4: EPERM. The process group could not be signalled. Action: kill its pid manually, or check with bg_status whether it is still running.",
      ].join("\n"),
    );
    expect(killText({ killed: [], alreadyFinished: [], failed: [] })).toBe("No task was killed.");
  });
});

describe("notificationText (golden)", () => {
  it("batches tasks under one header with their tails", () => {
    const text = notificationText({
      redelivery: false,
      items: [
        { task: summary(1, { state: "exited", exitCode: 0, runtimeS: 5 }), tail: ["ok"] },
        { task: summary(2, { state: "timed_out", runtimeS: 600, logPath: "/l/bg2.log" }), tail: [] },
      ],
    });
    expect(text).toBe(
      [
        "Background task notification:",
        "bg1 (job 1) exited with code 0 after 5s.\n    ok\nUse bg_output with id bg1 for more.",
        "bg2 (job 2) timed out (hard timeout) after 10m 00s.\n    (no output)\nLog: /l/bg2.log. Use bg_output with id bg2 for more.",
      ].join("\n"),
    );
  });

  it("marks a redelivery", () => {
    const text = notificationText({ redelivery: true, items: [{ task: summary(1, { state: "killed" }), tail: [] }] });
    expect(text.startsWith("Background task notification (sent again because the previous delivery was interrupted):")).toBe(true);
    expect(text).toContain("bg1 (job 1) was killed after 12s.");
  });
});

describe("failure texts (golden, one per code)", () => {
  const cases: [FailureCode, Record<string, string | number>, string][] = [
    ["unknown_id", { id: "bg9", known: "bg1, bg2" }, "No task bg9 in this session. Known: bg1, bg2. Action: use bg_status with no id to list the tasks, then retry with a listed id."],
    ["stale_id", { id: "bg3" }, "bg3 was started before this session was resumed or reloaded and was stopped when Pi exited. Action: start the command again."],
    ["spawn_failed", { cwd: "/nope", shell: "/bin/zsh", error: "ENOENT" }, "Could not start the command in /nope using /bin/zsh: ENOENT. Action: check that the working directory exists and the shell is installed, then run the command again."],
    ["task_limit", { limit: 16 }, "16 background tasks are running (limit maxRunningTasks). Action: kill one with bg_kill or wait for one to finish with bg_wait."],
    ["kill_failed", { id: "bg4", error: "EPERM", pid: 321 }, "Could not stop bg4: the process group could not be signalled (EPERM). Action: kill pid 321 manually, or check whether it is still running with bg_status."],
    ["kill_failed", { id: "bg4", error: "still running" }, "Could not stop bg4: the process group could not be signalled (still running). Action: check whether it is still running with bg_status, then stop it manually."],
    ["notify_failed", { error: "boom" }, "pi-bg could not deliver a notification (boom). Action: use bg_status to see finished tasks, or reload Pi."],
    ["listener_failed", { id: "bg2", error: "oops" }, "A pi-bg task listener failed while bg2 was ending: oops. Action: report this as a pi-bg bug."],
    ["handoff_missing", { id: "bg2" }, "The handed-off task bg2 is missing from the registry. Action: report this as a pi-bg bug."],
    ["shutdown_timeout", { seconds: 5, pid: "11, 12" }, "Some background tasks did not exit within 5 s of shutdown and were sent SIGKILL (pid 11, 12). Action: check for leftover processes with ps, and kill them manually if they remain."],
    ["shutdown_timeout", { seconds: 5 }, "Some background tasks did not exit within 5 s of shutdown and were sent SIGKILL. Action: check for leftover processes with ps, and kill them manually if they remain."],
    ["log_degraded", { id: "bg5", error: "ENOSPC", kib: 64 }, "Writing the log for bg5 failed: ENOSPC. Only the in-memory tail (last 64 KiB) is complete. Action: free disk space, or set output.logDir in pi-bg.json, then start the command again."],
    ["bad_grep", { pattern: "(", error: "Unterminated group" }, "Invalid grep pattern (: Unterminated group. Action: fix the regular expression (JavaScript syntax) and call bg_output again."],
    ["bad_override", { key: "timeout", value: "abc" }, "'abc' is not a valid timeout (a number of seconds, 0 disables). Action: run /bg timeout with a number of seconds, for example /bg timeout 30."],
    ["bad_override", { key: "notify", value: "loud" }, "'loud' is not a valid notify level (off, error, done). Action: run /bg notify with off, error, or done."],
    ["bash_owned", { owner: "other-ext" }, "bash is registered by other-ext, which took precedence; pi-bg cannot add run_in_background or ctrl+b. Action: remove the other bash override to use pi-bg."],
    ["inactive", { reason: "bash is owned by other-ext", action: "remove the other bash override to use pi-bg" }, "pi-bg is inactive: bash is owned by other-ext. There are no background tasks. Action: remove the other bash override to use pi-bg."],
    ["disabled", {}, "pi-bg is inactive: pi-bg is disabled (--no-bg flag or enabled=false in pi-bg.json). There are no background tasks. Action: remove --no-bg or set enabled to true in pi-bg.json, then reload."],
    ["disabled", { foreground: 1 }, "pi-bg is inactive: pi-bg is disabled (--no-bg flag or enabled=false in pi-bg.json). There are no background tasks. Action: remove --no-bg or set enabled to true in pi-bg.json, then reload, or run the command without run_in_background, bg_timeout and notify."],
    ["bash_inactive", { owner: "other-ext" }, "pi-bg is inactive: bash is owned by other-ext. There are no background tasks. Action: remove the other bash override, then reload Pi."],
    ["write_no_stdin", { id: "bg4" }, "bg4 was not started with stdin, so it cannot take input. Action: start the command again with bash stdin true, then write with bg_write."],
    ["write_finished", { id: "bg4", state: "exited" }, "bg4 has already ended (exited), so it cannot take input. Action: use bg_output to read what it printed, or start the command again."],
    ["write_too_large", { bytes: 70000, limit: 65536 }, "The write is 70000 bytes, over the 65536-byte limit for one bg_write call. Action: split the data into several bg_write calls."],
    ["write_failed", { id: "bg4", error: "stdin was already closed" }, "Could not write to the stdin of bg4: stdin was already closed. Action: read the output with bg_output to see why, and start the command again with stdin true if it still needs input."],
    ["kill_signal_unsupported", { signal: "INT" }, "bg_kill cannot send SIGINT because the fallback runner (Pi's native operations) can only abort a task with SIGKILL. Action: call bg_kill with signal KILL or without signal, or restore the own-spawn runner (a startup warning says why it is not in use)."],
    ["kill_not_exited", { id: "bg4", seconds: 5, pid: 7, graceful: 1, signal: "SIGINT" }, "Could not stop bg4: the process group could not be signalled (still running 5s after SIGINT and the runner's SIGKILL escalation). Action: kill pid 7 manually, or check whether it is still running with bg_status."],
    ["kill_no_handle", { id: "bg4", pid: 7 }, "Could not stop bg4: the process group could not be signalled (the task has no live process handle yet). Action: kill pid 7 manually, or check whether it is still running with bg_status."],
    ["kill_no_handle", { id: "bg4" }, "Could not stop bg4: the process group could not be signalled (the task has no live process handle yet). Action: check whether it is still running with bg_status, then stop it manually."],
    ["kill_not_exited", { id: "bg4", seconds: 5, pid: 7 }, "Could not stop bg4: the process group could not be signalled (still running 5s after SIGTERM and the runner's SIGKILL escalation). Action: kill pid 7 manually, or check whether it is still running with bg_status."],
    ["kill_not_exited", { id: "bg4", seconds: 5, pid: 7, graceful: 0 }, "Could not stop bg4: the process group could not be signalled (still running 5s after SIGKILL). Action: kill pid 7 manually, or check whether it is still running with bg_status."],
    ["config_unreadable", { file: "/h/pi-bg.json", label: "global", error: "EACCES" }, "Cannot read the global config /h/pi-bg.json: EACCES. pi-bg ignores this file and uses the default settings. Action: fix the file's permissions or path, then reload Pi."],
    ["config_bad_json", { file: "/h/pi-bg.json", error: "Unexpected token" }, "/h/pi-bg.json is not valid JSON: Unexpected token. pi-bg ignores this file and uses the default settings. Action: fix the syntax error in /h/pi-bg.json (a JSON validator shows where), then reload Pi."],
    ["log_cleanup_failed", { error: "Cannot list log directory /l: EACCES" }, "Log cleanup failed: Cannot list log directory /l: EACCES. Old logs are not deleted this session. Action: make the log directory readable and writable (output.logDir, or pi-bg-<uid> under the system temp directory); cleanup runs again at the next session start."],
    ["unsupported_platform", { platform: "win32" }, "pi-bg is inactive on win32 in v1; the built-in bash is unchanged. Action: use Linux or macOS, or remove pi-bg from your Pi packages."],
    ["wait_none", {}, "No background task is running, so there was nothing to wait for. Action: start a command with run_in_background, or use bg_status to see finished tasks."],
    ["wait_timeout", { seconds: 120 }, "The wait timed out after 120s with tasks still running. Action: call bg_wait again, or use bg_status to check progress."],
    ["kill_args", { both: 1 }, "Give either id or all to bg_kill, not both. Action: call bg_kill with only id (one task) or only all true (every running task)."],
    ["kill_args", { both: 0 }, "bg_kill needs exactly one of id or all. Action: call bg_kill with id set to a task id such as bg3, or with all true."],
    ["stream_unsupported", { stream: "stderr" }, "Stream stderr was requested, but this runner only provides combined output, so combined output is returned. Action: omit stream or use combined."],
  ];

  it.each(cases)("%s gives the exact text", (code, ctx, expected) => {
    expect(failure(code, ctx)).toBe(expected);
  });

  it.each(cases)("%s names a cause and an action", (code, ctx) => {
    const text = failure(code, ctx);
    expect(text).toMatch(/Action: /);
    expect(text.length).toBeGreaterThan(40);
  });

  it("never throws on missing placeholders and shows unknown instead", () => {
    expect(failure("unknown_id", {})).toContain("No task unknown in this session");
  });
});

describe("BASH_GUIDELINES", () => {
  it("names the five tools and the run_in_background and bg_timeout guidance", () => {
    const text = BASH_GUIDELINES.join("\n");
    for (const name of ["bg_status", "bg_output", "bg_wait", "bg_kill", "run_in_background", "bg_timeout"]) {
      expect(text).toContain(name);
    }
  });
});
