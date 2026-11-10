import { describe, expect, expectTypeOf, it } from "vitest";
import { Value } from "typebox/value";
import {
  BashParams,
  BgKillParams,
  BgOutputParams,
  BgStatusParams,
  BgWaitParams,
  SCHEMAS,
  BgMonitorParams,
  BgWriteParams,
  TOOL_NAMES,
  type BashArgs,
  type BgKillArgs,
  type BgOutputArgs,
  type BgStatusArgs,
  type BgWaitArgs,
  type ToolName,
} from "../../src/tools/schemas.js";

// Compile-time checks: each Static type equals the declared argument shape.
// A mismatch fails `npm run typecheck`, not only the runtime tests.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const shapes = {
  bash: true as Equal<
    BashArgs,
    {
      command: string;
      timeout?: number;
      bg_timeout?: number;
      run_in_background?: boolean;
      notify?: "off" | "error" | "done";
      description?: string;
      stdin?: boolean;
    }
  >,
  status: true as Equal<BgStatusArgs, { id?: string; tail_lines?: number; include_finished?: boolean }>,
  output: true as Equal<
    BgOutputArgs,
    {
      id: string;
      tail_lines?: number;
      since?: number;
      grep?: string;
      context?: number;
      max_bytes?: number;
      stream?: "combined" | "stdout" | "stderr";
    }
  >,
  wait: true as Equal<BgWaitArgs, { ids?: string[]; mode?: "any" | "all"; timeout_s?: number }>,
  kill: true as Equal<BgKillArgs, { id?: string; all?: boolean }>,
};

// A value typed as the Static argument shape satisfies the shape, so producers and consumers agree.
const sampleBash = { command: "npm test", bg_timeout: 5 } satisfies BashArgs;
const sampleOutput = { id: "bg1", stream: "stderr" } satisfies BgOutputArgs;

function accepts(schema: unknown, value: unknown): boolean {
  return Value.Check(schema as Parameters<typeof Value.Check>[0], value);
}

describe("tool schemas: accept and reject", () => {
  it("bash accepts a minimal command and every new parameter", () => {
    expect(accepts(BashParams, { command: "ls" })).toBe(true);
    expect(
      accepts(BashParams, {
        command: "make",
        timeout: 600,
        bg_timeout: 30,
        run_in_background: true,
        notify: "error",
        description: "build",
      }),
    ).toBe(true);
  });

  it("bash rejects a missing or empty command, negative timeouts, unknown notify levels and wrong types", () => {
    expect(accepts(BashParams, {})).toBe(false);
    expect(accepts(BashParams, { command: "" })).toBe(false);
    expect(accepts(BashParams, { command: "ls", timeout: -1 })).toBe(false);
    expect(accepts(BashParams, { command: "ls", bg_timeout: -5 })).toBe(false);
    expect(accepts(BashParams, { command: "ls", notify: "always" })).toBe(false);
    expect(accepts(BashParams, { command: "ls", run_in_background: "yes" })).toBe(false);
  });

  it("bg_status accepts no id (list) and an id; rejects a non-string id", () => {
    expect(accepts(BgStatusParams, {})).toBe(true);
    expect(accepts(BgStatusParams, { id: "bg2", tail_lines: 0 })).toBe(true);
    expect(accepts(BgStatusParams, { id: 2 })).toBe(false);
    expect(accepts(BgStatusParams, { tail_lines: 1.5 })).toBe(false);
  });

  it("bg_output accepts cursors and streams; rejects a missing id and an unknown stream", () => {
    expect(accepts(BgOutputParams, { id: "bg1", since: 0, stream: "stdout", grep: "ERROR", context: 2 })).toBe(true);
    expect(accepts(BgOutputParams, { since: 0 })).toBe(false);
    expect(accepts(BgOutputParams, { id: "bg1", stream: "pty" })).toBe(false);
    expect(accepts(BgOutputParams, { id: "bg1", max_bytes: 0 })).toBe(false);
  });

  it("bg_wait accepts ids and modes within the timeout bound; rejects out-of-range values", () => {
    expect(accepts(BgWaitParams, {})).toBe(true);
    expect(accepts(BgWaitParams, { ids: ["bg1"], mode: "all", timeout_s: 3600 })).toBe(true);
    expect(accepts(BgWaitParams, { mode: "first" })).toBe(false);
    expect(accepts(BgWaitParams, { timeout_s: 3601 })).toBe(false);
    expect(accepts(BgWaitParams, { ids: "bg1" })).toBe(false);
  });

  it("bg_kill accepts id or all and rejects wrong types", () => {
    expect(accepts(BgKillParams, { id: "bg3" })).toBe(true);
    expect(accepts(BgKillParams, { all: true })).toBe(true);
    expect(accepts(BgKillParams, { all: "yes" })).toBe(false);
  });
});

describe("bg_monitor params", () => {
  it("requires id and bounds max_notifications to 1..100", () => {
    expect(accepts(BgMonitorParams, { id: "bg3" })).toBe(true);
    expect(accepts(BgMonitorParams, { id: "bg3", grep: "ERR", max_notifications: 100, stop: false })).toBe(true);
    expect(accepts(BgMonitorParams, { id: "bg3", max_notifications: 1 })).toBe(true);
    expect(accepts(BgMonitorParams, {})).toBe(false);
    expect(accepts(BgMonitorParams, { id: "bg3", max_notifications: 0 })).toBe(false);
    expect(accepts(BgMonitorParams, { id: "bg3", max_notifications: 101 })).toBe(false);
    expect(accepts(BgMonitorParams, { id: "bg3", max_notifications: 2.5 })).toBe(false);
    expect(accepts(BgMonitorParams, { id: "bg3", stop: "yes" })).toBe(false);
  });
});

describe("SCHEMAS and TOOL_NAMES", () => {
  it("has one schema per tool name, in a fixed order", () => {
    expect(TOOL_NAMES).toEqual(["bash", "bg_status", "bg_output", "bg_wait", "bg_kill", "bg_write", "bg_monitor"]);
    expect(Object.keys(SCHEMAS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("maps each name to its own schema object", () => {
    expect(SCHEMAS.bash).toBe(BashParams);
    expect(SCHEMAS.bg_status).toBe(BgStatusParams);
    expect(SCHEMAS.bg_output).toBe(BgOutputParams);
    expect(SCHEMAS.bg_wait).toBe(BgWaitParams);
    expect(SCHEMAS.bg_kill).toBe(BgKillParams);
    expect(SCHEMAS.bg_write).toBe(BgWriteParams);
    expect(SCHEMAS.bg_monitor).toBe(BgMonitorParams);
  });

  it("type ToolName is exactly the tool names", () => {
    expectTypeOf<ToolName>().toEqualTypeOf<"bash" | "bg_status" | "bg_output" | "bg_wait" | "bg_kill" | "bg_write" | "bg_monitor">();
  });

  it("the compile-time shape checks hold", () => {
    expect(Object.values(shapes).every((ok) => ok === true)).toBe(true);
    expect(sampleBash.command).toBe("npm test");
    expect(sampleOutput.id).toBe("bg1");
  });
});

describe("negative control", () => {
  it("a wrong expected shape is not equal (the Equal helper can fail)", () => {
    const wrong: Equal<BgKillArgs, { id: string; all?: boolean }> = false;
    expect(wrong).toBe(false);
  });
});
