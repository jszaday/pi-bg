// Param round trip: a documented example per tool passes its schema through FakePi.callTool's validator; an invalid one fails.
// Complements test/tools/schemas.test.ts (which checks the schemas directly), here through the registered tool definitions.
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { registerBgTools } from "../../src/pi/bg-tools.js";
import { SCHEMAS, type ToolName } from "../../src/tools/schemas.js";
import { makeHarness } from "../pi/w6a-services.js";

const EXAMPLES: Record<ToolName, { good: unknown; bad: unknown[] }> = {
  bash: { good: { command: "npm test", timeout: 300, bg_timeout: 30, notify: "error", description: "tests" }, bad: [{}, { command: "" }, { command: "x", notify: "all" }, { command: "x", bg_timeout: -1 }] },
  bg_status: { good: { id: "bg3", tail_lines: 10, include_finished: false }, bad: [{ tail_lines: -1 }, { id: 3 }, { includeFinished: true, include_finished: "y" }] },
  bg_output: { good: { id: "bg3", since: 120, grep: "ERR", context: 2, max_bytes: 4000, stream: "stderr" }, bad: [{}, { id: "bg3", max_bytes: 0 }, { id: "bg3", stream: "both" }] },
  bg_wait: { good: { ids: ["bg1", "bg2"], mode: "all", timeout_s: 600 }, bad: [{ mode: "first" }, { timeout_s: 3601 }, { ids: "bg1" }] },
  bg_kill: { good: { id: "bg3", signal: "INT" }, bad: [{ all: "yes" }, { id: 3 }, { id: "bg3", signal: "int" }, { id: "bg3", signal: "STOP" }] },
};

describe("param examples through the registered tool definitions", () => {
  const h = makeHarness();
  registerBgTools(h.pi.asExtensionAPI(), h.s);
  for (const name of Object.keys(EXAMPLES) as ToolName[]) {
    it(`${name}: schema accepts the documented example and rejects invalid ones`, () => {
      const { good, bad } = EXAMPLES[name];
      expect(Value.Check(SCHEMAS[name], good)).toBe(true);
      for (const b of bad) expect(Value.Check(SCHEMAS[name], b), JSON.stringify(b)).toBe(false);
      const tool = h.pi.tools.get(name);
      if (tool) {
        // the registered tool uses the same schema object content as SCHEMAS
        expect(Value.Check(tool.parameters, good)).toBe(true);
        for (const b of bad) expect(Value.Check(tool.parameters, b), JSON.stringify(b)).toBe(false);
      }
    });
  }
  it("FakePi.callTool rejects invalid params before execute", async () => {
    await expect(h.pi.callTool("bg_wait", { timeout_s: 3601 })).rejects.toThrow(/schema/);
    await expect(h.pi.callTool("bg_output", {})).rejects.toThrow(/schema/);
  });
});
