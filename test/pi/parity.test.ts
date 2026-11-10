import { afterEach, describe, expect, it } from "vitest";
import piBg from "../../src/index.js";
import { RESULT_MAPPERS } from "../../src/pi/results.js";
import { SCHEMAS } from "../../src/tools/schemas.js";
import { FakePi } from "../fakes/index.js";
import { w8Ctx } from "./w8-helpers.js";

/** Returns the parity problems between the registered tool names and the two canonical key sets (empty = parity). */
function parityProblems(registered: string[], schemaKeys: string[], mapperKeys: string[]): string[] {
  const reg = new Set(registered);
  const problems: string[] = [];
  for (const k of schemaKeys) if (!reg.has(k)) problems.push(`schema without registered tool: ${k}`);
  for (const k of mapperKeys) if (!reg.has(k)) problems.push(`result mapper without registered tool: ${k}`);
  for (const r of registered) {
    if (!schemaKeys.includes(r)) problems.push(`registered tool without schema: ${r}`);
    if (!mapperKeys.includes(r)) problems.push(`registered tool without result mapper: ${r}`);
  }
  return problems;
}

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("composition root parity", () => {
  it("registers exactly the tools of SCHEMAS and RESULT_MAPPERS", () => {
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    expect(parityProblems([...pi.tools.keys()], Object.keys(SCHEMAS), Object.keys(RESULT_MAPPERS))).toEqual([]);
    expect(Object.keys(SCHEMAS).sort()).toEqual(Object.keys(RESULT_MAPPERS).sort());
  });

  it("negative control: an extra or a missing registered tool is detected", () => {
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    const names = [...pi.tools.keys()];
    expect(parityProblems([...names, "bg_extra"], Object.keys(SCHEMAS), Object.keys(RESULT_MAPPERS))).toHaveLength(2);
    expect(parityProblems(names.filter((n) => n !== "bg_wait"), Object.keys(SCHEMAS), Object.keys(RESULT_MAPPERS))).toHaveLength(2);
  });

  it("registers the flags, the /bg command, the notification renderer and the lifecycle handlers", () => {
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    expect([...pi.flags.keys()].sort()).toEqual(["bg-notify", "bg-timeout", "no-bg"]);
    expect(pi.commands.has("bg")).toBe(true);
    expect(pi.renderers.has("pi-bg:task")).toBe(true);
    for (const ev of ["session_start", "session_shutdown", "input", "message_end", "agent_settled"]) {
      expect(pi.handlers.get(ev)?.length, ev).toBeGreaterThan(0);
    }
  });

  const startCtx = (pi: FakePi) =>
    w8Ctx(pi, { mode: "tui", isProjectTrusted: () => false, sessionManager: { getBranch: () => [], getSessionId: () => "s1" } });

  it("on Linux session_start installs the move key; shutdown removes it", async () => {
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, startCtx(pi));
    expect(pi.ui.listeners).toHaveLength(1);
    await pi.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, startCtx(pi));
    expect(pi.ui.listeners).toHaveLength(0);
  });

  it("with the platform stubbed to Windows pi-bg stays inactive and says so", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const pi = new FakePi();
    piBg(pi.asExtensionAPI());
    await pi.emit("session_start", { type: "session_start", reason: "startup" }, startCtx(pi));
    expect(pi.ui.listeners).toHaveLength(0);
    expect(pi.ui.notices.some((n) => n.msg.includes("Windows"))).toBe(true);
    await expect(pi.callTool("bg_status", {}, { ctx: startCtx(pi) })).rejects.toThrow(/inactive on Windows/);
  });
});
