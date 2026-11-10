import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { loadConfig, registerFlags, setSessionOverride } from "../../src/pi/config-load.js";
import { FakePi } from "../fakes/index.js";
import { w8Services } from "./w8-helpers.js";

let root: string;
let agentDir: string;
let projectDir: string;
const savedEnv = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "w8-config-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

const ctx = (trusted: unknown) => ({ cwd: projectDir, isProjectTrusted: trusted }) as never;
const writeGlobal = (o: unknown) => writeFileSync(join(agentDir, "pi-bg.json"), typeof o === "string" ? o : JSON.stringify(o));
const writeProject = (o: unknown) => writeFileSync(join(projectDir, ".pi", "pi-bg.json"), JSON.stringify(o));

describe("registerFlags", () => {
  it("registers the three flags with the core's keys", () => {
    const pi = new FakePi();
    registerFlags(pi.asExtensionAPI());
    expect([...pi.flags.keys()].sort()).toEqual(["bg-notify", "bg-timeout", "no-bg"]);
    expect((pi.flags.get("no-bg") as { type: string }).type).toBe("boolean");
    expect((pi.flags.get("bg-timeout") as { type: string }).type).toBe("string");
  });
});

describe("loadConfig", () => {
  it("returns defaults with no files and no warnings", () => {
    const r = loadConfig(new FakePi().asExtensionAPI(), ctx(() => true));
    expect(r.config).toEqual(DEFAULT_CONFIG);
    expect(r.warnings).toEqual([]);
  });

  it("rejects a relative output.logDir with a warning naming the value and the action, and uses the default", () => {
    writeGlobal({ output: { logDir: "logs/pi-bg" } });
    const r = loadConfig(new FakePi().asExtensionAPI(), ctx(() => true));
    expect(r.config.output.logDir).toBeNull();
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('"logs/pi-bg"');
    expect(r.warnings[0]).toContain("absolute");
    expect(r.warnings[0]).toContain("Action");
  });

  it("keeps an absolute output.logDir without a warning (negative control)", () => {
    writeGlobal({ output: { logDir: join(root, "logs") } });
    const r = loadConfig(new FakePi().asExtensionAPI(), ctx(() => true));
    expect(r.config.output.logDir).toBe(join(root, "logs"));
    expect(r.warnings).toEqual([]);
  });

  it("normalises a loosely written key (case, separator) without a warning", () => {
    writeGlobal({ key: "Ctrl-G" });
    const r = loadConfig(new FakePi().asExtensionAPI(), ctx(() => true));
    expect(r.config.key).toBe("ctrl+g");
    expect(r.warnings).toEqual([]);
  });

  it.each(["ctrl+bb", "ctrl+nope", "meta+b", "ctrl+"])("warns for key %j with the value and the accepted form, and falls back to the default key", (bad) => {
    writeGlobal({ key: bad });
    const r = loadConfig(new FakePi().asExtensionAPI(), ctx(() => true));
    expect(r.config.key).toBe(DEFAULT_CONFIG.key);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(JSON.stringify(bad));
    expect(r.warnings[0]).toContain("ctrl+b");
    expect(r.warnings[0]).toContain("Action");
  });

  it("merges global, trusted project and flags in precedence order", () => {
    writeGlobal({ bgTimeoutSeconds: 10, key: "ctrl+g" });
    writeProject({ bgTimeoutSeconds: 20 });
    const pi = new FakePi();
    pi.setFlag("bg-notify", "error");
    pi.setFlag("no-bg", true);
    const { config } = loadConfig(pi.asExtensionAPI(), ctx(() => true));
    expect(config.bgTimeoutSeconds).toBe(20);
    expect(config.key).toBe("ctrl+g");
    expect(config.notify.default).toBe("error");
    expect(config.enabled).toBe(false);
  });

  it("ignores the project file when untrusted, or when isProjectTrusted is absent or not a function", () => {
    writeProject({ bgTimeoutSeconds: 20 });
    for (const trusted of [() => false, undefined, true, "yes"]) {
      const { config } = loadConfig(new FakePi().asExtensionAPI(), ctx(trusted));
      expect(config.bgTimeoutSeconds).toBe(30);
    }
  });

  it("warns once on invalid JSON with cause and action, and falls back to defaults", () => {
    writeGlobal("{ not json");
    const { config, warnings } = loadConfig(new FakePi().asExtensionAPI(), ctx(() => false));
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pi-bg.json");
    expect(warnings[0]).toContain("not valid JSON");
    expect(warnings[0]).toContain("Action:");
  });

  it("passes parseConfig warnings through (invalid key, bad flag)", () => {
    writeGlobal({ bgTimeoutSeconds: "soon" });
    const pi = new FakePi();
    pi.setFlag("bg-timeout", "abc");
    const { config, warnings } = loadConfig(pi.asExtensionAPI(), ctx(() => false));
    expect(config.bgTimeoutSeconds).toBe(30);
    expect(warnings.some((w) => w.includes("bgTimeoutSeconds"))).toBe(true);
    expect(warnings.some((w) => w.includes("--bg-timeout"))).toBe(true);
  });
});

describe("setSessionOverride", () => {
  it("accepts a timeout in seconds, including 0", () => {
    const { s } = w8Services();
    expect(setSessionOverride(s, "timeout", "45")).toContain("45s");
    expect(s.overrides.bgTimeoutSeconds).toBe(45);
    expect(setSessionOverride(s, "timeout", "0")).toContain("off");
    expect(s.overrides.bgTimeoutSeconds).toBe(0);
  });

  it("rejects bad timeouts with cause and action and leaves the override unchanged", () => {
    const { s } = w8Services();
    s.overrides.bgTimeoutSeconds = 7;
    for (const bad of ["abc", "-1", "", "  ", "Infinity"]) {
      const msg = setSessionOverride(s, "timeout", bad);
      expect(msg).toContain("/bg timeout");
      expect(msg).toContain("Action:");
      expect(s.overrides.bgTimeoutSeconds).toBe(7);
    }
  });

  it("accepts the three notify levels and rejects others", () => {
    const { s } = w8Services();
    for (const l of ["off", "error", "done"] as const) {
      expect(setSessionOverride(s, "notify", l)).toContain(l);
      expect(s.overrides.notifyLevel).toBe(l);
    }
    const msg = setSessionOverride(s, "notify", "loud");
    expect(msg).toContain("Action:");
    expect(s.overrides.notifyLevel).toBe("done");
  });

  it("uses the bad_override text for bad /bg values", () => {
    const { s } = w8Services();
    expect(setSessionOverride(s, "timeout", "abc")).toBe(
      "'abc' is not a valid timeout (a number of seconds, 0 disables). Action: run /bg timeout with a number of seconds, for example /bg timeout 30.",
    );
    expect(setSessionOverride(s, "notify", "loud")).toBe(
      "'loud' is not a valid notify level (off, error, done). Action: run /bg notify with off, error, or done.",
    );
  });
});
