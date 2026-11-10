import { afterEach, describe, expect, it, vi } from "vitest";
import type { KillResult } from "../../src/core/format.js";
import { failure } from "../../src/core/format.js";
import { registerBgCommand } from "../../src/pi/command.js";
import { w7Ctx, w7Setup, w7Spec } from "./w7-helpers.js";

type Cmd = {
  getArgumentCompletions(p: string): { value: string; label: string }[] | null;
  handler(args: string, ctx: unknown): Promise<void>;
};

function setup(mode: "tui" | "print" = "tui") {
  const s = w7Setup();
  const kill = vi.fn(async (): Promise<KillResult> => ({ killed: ["bg1"], alreadyFinished: [], failed: [] }));
  const move = vi.fn(() => ["bg1", "bg2"]);
  const setSession = vi.fn((k: string, v: string) => `set ${k}=${v}`);
  const tailOf = vi.fn(() => ["line a", "line b"]);
  registerBgCommand(s.pi.asExtensionAPI(), { registry: s.registry, kill, move, setSession, tailOf });
  const cmd = s.pi.commands.get("bg") as Cmd;
  const ctx = w7Ctx(s.pi, mode);
  const run = async (args: string) => {
    s.pi.ui.notices.length = 0;
    await cmd.handler(args, ctx);
    return s.pi.ui.notices.map((n) => n);
  };
  return { ...s, cmd, kill, move, setSession, tailOf, run };
}

afterEach(() => vi.restoreAllMocks());

describe("/bg", () => {
  it("lists tasks, and says so when there are none", async () => {
    const t = setup();
    expect((await t.run(""))[0].msg).toContain("No background tasks");
    t.registry.create(w7Spec({ startInBackground: true, label: "build" }));
    const [n] = await t.run("list");
    expect(n.msg).toContain("1 background task(s)");
    expect(n.msg).toContain("bg1");
    expect(n.msg).toContain("build");
  });

  it("tail shows output of a known id", async () => {
    const t = setup();
    t.registry.create(w7Spec({ startInBackground: true }));
    const [n] = await t.run("tail bg1");
    expect(n.msg).toContain("Showing the end of bg1");
    expect(n.msg).toContain("line a\nline b");
    expect(t.tailOf).toHaveBeenCalledWith("bg1");
  });

  it("tail reports unknown and stale ids as errors", async () => {
    const t = setup();
    t.registry.create(w7Spec({ startInBackground: true }));
    expect(await t.run("tail bg9")).toEqual([{ msg: failure("unknown_id", { id: "bg9", known: "bg1" }), level: "error" }]);
    expect(await t.run("tail")).toEqual([{ msg: failure("unknown_id", { id: "", known: "bg1" }), level: "error" }]);
  });

  it("kill all and kill <id> call kill and report", async () => {
    const t = setup();
    t.registry.create(w7Spec({ startInBackground: true }));
    const [a] = await t.run("kill all");
    expect(t.kill).toHaveBeenLastCalledWith("all");
    expect(a.msg).toBe("Killed 1 background task(s).");
    await t.run("kill bg1");
    expect(t.kill).toHaveBeenLastCalledWith("bg1");
  });

  it("kill with unknown id does not call kill; without argument shows help", async () => {
    const t = setup();
    const [a] = await t.run("kill bg7");
    expect(a.level).toBe("error");
    expect(a.msg).toContain("No task bg7");
    expect(t.kill).not.toHaveBeenCalled();
    const [b] = await t.run("kill");
    expect(b.level).toBe("warning");
    expect(b.msg).toContain("/bg kill <id|all>");
  });

  it("kill failure is reported as an error", async () => {
    const t = setup();
    t.registry.create(w7Spec({ startInBackground: true }));
    t.kill.mockResolvedValueOnce({ killed: [], alreadyFinished: [], failed: [{ id: "bg1", error: "EPERM" }] });
    const [a] = await t.run("kill bg1");
    expect(a.level).toBe("error");
    expect(a.msg).toContain("Could not stop bg1");
  });

  it("timeout and notify forward to setSession and show its text", async () => {
    const t = setup();
    expect((await t.run("timeout 45"))[0].msg).toBe("set timeout=45");
    expect((await t.run("notify error"))[0].msg).toBe("set notify=error");
    t.setSession.mockReturnValueOnce("bad value");
    expect((await t.run("timeout abc"))[0].msg).toBe("bad value");
    await t.run("timeout");
    expect(t.setSession).toHaveBeenLastCalledWith("timeout", "");
  });

  it("move hands off and reports the count", async () => {
    const t = setup();
    expect((await t.run("move"))[0].msg).toBe("Moved 2 command(s) to the background.");
    expect(t.move).toHaveBeenCalledTimes(1);
  });

  it("help and an unknown subcommand show the help text (the latter as a warning)", async () => {
    const t = setup();
    const [h] = await t.run("help");
    expect(h.level).toBe("info");
    expect(h.msg).toContain("/bg move");
    const [u] = await t.run("frobnicate");
    expect(u).toEqual({ msg: h.msg, level: "warning" });
  });

  it("writes to stderr in print mode", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const t = setup("print");
    await t.run("help");
    expect(t.pi.ui.notices).toEqual([]);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("/bg move"));
  });

  describe("completions", () => {
    it("completes subcommands", () => {
      const t = setup();
      expect(t.cmd.getArgumentCompletions("")!.map((i) => i.value)).toEqual(["kill", "tail", "timeout", "notify", "move", "help"]);
      expect(t.cmd.getArgumentCompletions("ti")!.map((i) => i.value)).toEqual(["timeout"]);
      expect(t.cmd.getArgumentCompletions("zz")).toBeNull();
    });

    it("completes ids from the registry: running for kill, all for tail", () => {
      const t = setup();
      const a = t.registry.create(w7Spec({ startInBackground: true }));
      t.registry.create(w7Spec({ startInBackground: true }));
      t.registry.dispatch(a.id, { type: "exit", code: 0, signal: null, at: 1 });
      expect(t.cmd.getArgumentCompletions("kill ")!.map((i) => i.value)).toEqual(["kill all", "kill bg2"]);
      expect(t.cmd.getArgumentCompletions("tail b")!.map((i) => i.value)).toEqual(["tail bg1", "tail bg2"]);
      expect(t.cmd.getArgumentCompletions("tail x")).toBeNull();
    });

    it("completes notify levels", () => {
      const t = setup();
      expect(t.cmd.getArgumentCompletions("notify o")!.map((i) => i.value)).toEqual(["notify off"]);
    });
  });
});
